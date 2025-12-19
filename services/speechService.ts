import { Rule, RuleType } from '../types';
import { synthesizeChunk } from './cloudTtsService';
import { getAudioFromCache, saveAudioToCache, generateAudioKey } from './audioCache';

export function applyRules(text: string, rules: Rule[]): string {
  let processedText = text;
  const activeRules = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  activeRules.forEach(rule => {
    let flags = 'g';
    if (!rule.matchCase) flags += 'i';
    
    let pattern = rule.matchExpression 
      ? rule.find 
      : rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (rule.wholeWord && !rule.matchExpression) {
      pattern = `\\b${pattern}\\b`;
    }

    try {
      const regex = new RegExp(pattern, flags);
      const replacement = rule.ruleType === RuleType.REPLACE ? "" : (rule.speakAs || "");
      processedText = processedText.replace(regex, replacement);
    } catch (e) {
      console.warn("Invalid regex for rule:", rule.find);
    }
  });

  return processedText;
}

interface SpeechChunk {
  text: string;
  startOffset: number;
}

export interface NextSegment {
  announcementPrefix: string;
  content: string;
  bookTitle: string;
  chapterTitle: string;
}

export interface PlaybackMetadata {
  currentTime: number;
  duration: number;
  charOffset: number;
}

class SpeechController {
  private synth: SpeechSynthesis;
  private audio: HTMLAudioElement;
  private currentChunks: SpeechChunk[] = [];
  private currentChunkIndex: number = -1;
  private rafId: number | null = null;
  
  private onEndCallback: (() => void) | null = null;
  private syncCallback: ((meta: PlaybackMetadata) => void) | null = null;
  
  private rate: number = 1.0;
  private voiceName: string = '';
  private sessionToken: number = 0;
  private getNextSegment: (() => Promise<NextSegment | null>) | null = null;
  
  private isUsingSingleBlob: boolean = false;
  private fullTextLengthForBlob: number = 0;

  constructor() {
    this.synth = window.speechSynthesis;
    this.audio = new Audio();
    this.setupAudioListeners();
  }

  private setupAudioListeners() {
    this.audio.addEventListener('ended', () => {
      if (this.isUsingSingleBlob) {
        this.stop();
        if (this.onEndCallback) this.onEndCallback();
        return;
      }

      if (this.syncCallback && this.currentChunkIndex >= 0) {
        const chunk = this.currentChunks[this.currentChunkIndex];
        this.syncCallback({
          currentTime: this.audio.duration,
          duration: this.audio.duration,
          charOffset: chunk.startOffset + chunk.text.length
        });
      }
      this.currentChunkIndex++;
      this.playNextChunk();
    });

    this.audio.addEventListener('play', () => {
      this.startSyncLoop();
    });

    this.audio.addEventListener('pause', () => {
      this.stopSyncLoop();
    });

    this.audio.addEventListener('error', (e) => {
      console.error("Audio element error:", this.audio.error);
    });
  }

  private startSyncLoop() {
    const sync = () => {
      if (this.syncCallback && this.audio.duration && !this.audio.paused) {
        if (this.isUsingSingleBlob) {
          const ratio = Math.min(1, this.audio.currentTime / this.audio.duration);
          this.syncCallback({
            currentTime: this.audio.currentTime,
            duration: this.audio.duration,
            charOffset: Math.floor(this.fullTextLengthForBlob * ratio)
          });
        } else if (this.currentChunkIndex >= 0) {
          const chunk = this.currentChunks[this.currentChunkIndex];
          if (chunk) {
            const ratio = Math.min(1, this.audio.currentTime / this.audio.duration);
            const charOffset = Math.floor(chunk.text.length * ratio);
            const totalGlobalOffset = chunk.startOffset + charOffset;
            this.syncCallback({
              currentTime: this.audio.currentTime,
              duration: this.audio.duration,
              charOffset: totalGlobalOffset
            });
          }
        }
      }
      this.rafId = requestAnimationFrame(sync);
    };
    this.stopSyncLoop();
    this.rafId = requestAnimationFrame(sync);
  }

  private stopSyncLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private createChunks(text: string): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    const MAX = 4800; 
    const parts = text.split(/([.!?\n]\s*)/);
    let current = "";
    let start = 0;

    parts.forEach(p => {
      if (current.length + p.length > MAX) {
        if (current) chunks.push({ text: current, startOffset: start });
        start += current.length;
        current = p;
      } else {
        current += p;
      }
    });
    if (current) chunks.push({ text: current, startOffset: start });
    return chunks;
  }

  /**
   * Enhanced speak function that accepts a direct Audio Blob (from Drive)
   */
  async speak(
    text: string, 
    voiceName: string, 
    rate: number, 
    startOffset: number, 
    onEnd: () => void, 
    onSync?: (meta: PlaybackMetadata) => void,
    getNextSegment?: () => Promise<NextSegment | null>,
    preFetchedAudio?: Blob
  ) {
    this.sessionToken++;
    const session = this.sessionToken;
    this.stop();
    
    this.onEndCallback = onEnd;
    this.syncCallback = onSync || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;

    if (preFetchedAudio) {
      this.isUsingSingleBlob = true;
      this.fullTextLengthForBlob = text.length;
      const url = URL.createObjectURL(preFetchedAudio);
      this.audio.src = url;
      
      const onLoaded = () => {
        if (this.sessionToken === session) {
          const ratio = Math.max(0, Math.min(1, startOffset / Math.max(1, text.length)));
          if (this.audio.duration) {
             this.audio.currentTime = ratio * this.audio.duration;
          }
          this.audio.play().catch(err => {
            console.warn("Playback prevented. User interaction required?", err);
          });
        }
        this.audio.removeEventListener('loadedmetadata', onLoaded);
      };
      this.audio.addEventListener('loadedmetadata', onLoaded);
      return;
    }

    this.isUsingSingleBlob = false;
    this.currentChunks = this.createChunks(text);
    const idx = this.currentChunks.findIndex(c => c.startOffset + c.text.length > startOffset);
    this.currentChunkIndex = idx !== -1 ? idx : 0;

    this.playNextChunk(startOffset);
  }

  seekToOffset(offset: number) {
    if (this.isUsingSingleBlob) {
      if (this.audio.duration) {
        const ratio = Math.max(0, Math.min(1, offset / Math.max(1, this.fullTextLengthForBlob)));
        this.audio.currentTime = ratio * this.audio.duration;
      }
      return;
    }

    if (this.currentChunks.length === 0) return;
    const idx = this.currentChunks.findIndex(c => c.startOffset + c.text.length > offset);
    if (idx === -1) return;

    if (idx === this.currentChunkIndex && this.audio.src && this.audio.duration) {
      const chunk = this.currentChunks[idx];
      const relative = offset - chunk.startOffset;
      const ratio = Math.max(0, Math.min(1, relative / chunk.text.length));
      this.audio.currentTime = ratio * this.audio.duration;
    } else {
      this.currentChunkIndex = idx;
      this.playNextChunk(offset);
    }
  }

  private async playNextChunk(initialOffsetInChunk?: number) {
    const session = this.sessionToken;

    if (this.currentChunkIndex >= this.currentChunks.length) {
      if (this.getNextSegment) {
        const next = await this.getNextSegment();
        if (next && this.sessionToken === session) {
          this.currentChunks = this.createChunks(next.announcementPrefix + next.content);
          this.currentChunkIndex = 0;
          this.playNextChunk();
          return;
        }
      }
      this.stop();
      if (this.onEndCallback) this.onEndCallback();
      return;
    }

    const chunk = this.currentChunks[this.currentChunkIndex];
    
    try {
      const cacheKey = generateAudioKey(chunk.text, this.voiceName, this.rate);
      const cachedBlob = await getAudioFromCache(cacheKey);
      let audioUrl = "";

      if (cachedBlob) {
        audioUrl = URL.createObjectURL(cachedBlob);
      } else {
        const result = await synthesizeChunk(chunk.text, this.voiceName, this.rate);
        if (this.sessionToken !== session) return;
        audioUrl = result.audioUrl;
        
        fetch(audioUrl).then(r => r.blob()).then(blob => {
          saveAudioToCache(cacheKey, blob);
        });
      }

      this.audio.src = audioUrl;

      const onLoaded = () => {
        if (this.sessionToken === session) {
          if (initialOffsetInChunk !== undefined) {
            const relative = Math.max(0, initialOffsetInChunk - chunk.startOffset);
            const ratio = Math.min(1, relative / Math.max(1, chunk.text.length));
            if (this.audio.duration) {
               this.audio.currentTime = ratio * this.audio.duration;
            }
          }
          this.audio.play().catch(() => {});
        }
        this.audio.removeEventListener('loadedmetadata', onLoaded);
      };

      this.audio.addEventListener('loadedmetadata', onLoaded);
    } catch (err) {
      console.error("Perfect sync failed, chunk fallback:", err);
    }
  }

  pause() {
    this.audio.pause();
  }

  resume() {
    this.audio.play().catch(() => {});
  }

  stop() {
    this.sessionToken++;
    this.stopSyncLoop();
    this.audio.pause();
    if (this.audio.src && this.audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.audio.src);
    }
    this.audio.src = "";
    this.synth.cancel();
    this.isUsingSingleBlob = false;
  }

  get isPaused() {
    return this.audio.paused;
  }
}

export const speechController = new SpeechController();