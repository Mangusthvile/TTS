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
  
  // Flag to detect if we should use Cloud TTS
  private isCloudEnabled: boolean = true;

  constructor() {
    this.synth = window.speechSynthesis;
    this.audio = new Audio();
    this.setupAudioListeners();
  }

  private setupAudioListeners() {
    this.audio.addEventListener('ended', () => {
      this.currentChunkIndex++;
      this.playNextChunk();
    });

    this.audio.addEventListener('play', () => {
      this.startSyncLoop();
    });

    this.audio.addEventListener('pause', () => {
      this.stopSyncLoop();
    });
  }

  private startSyncLoop() {
    const sync = () => {
      if (this.syncCallback && this.currentChunkIndex >= 0) {
        const chunk = this.currentChunks[this.currentChunkIndex];
        if (chunk && this.audio.duration && !this.audio.paused) {
          const ratio = this.audio.currentTime / this.audio.duration;
          const charOffset = Math.floor(chunk.text.length * ratio);
          const totalGlobalOffset = chunk.startOffset + charOffset;
          
          this.syncCallback({
            currentTime: this.audio.currentTime,
            duration: this.audio.duration,
            charOffset: totalGlobalOffset
          });
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

  async speak(
    text: string, 
    voiceName: string, 
    rate: number, 
    startOffset: number, 
    onEnd: () => void, 
    onSync?: (meta: PlaybackMetadata) => void,
    getNextSegment?: () => Promise<NextSegment | null>
  ) {
    this.sessionToken++;
    this.stop();
    
    this.onEndCallback = onEnd;
    this.syncCallback = onSync || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;

    this.currentChunks = this.createChunks(text);
    const idx = this.currentChunks.findIndex(c => c.startOffset + c.text.length > startOffset);
    this.currentChunkIndex = idx !== -1 ? idx : 0;

    this.playNextChunk(startOffset);
  }

  seekToOffset(offset: number) {
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
        
        // Persist to cache
        fetch(audioUrl).then(r => r.blob()).then(blob => {
          saveAudioToCache(cacheKey, blob);
        });
      }

      this.audio.src = audioUrl;
      this.audio.playbackRate = 1.0; // Audio is pre-rendered at correct rate usually, or we can use playbackRate

      const onLoaded = () => {
        if (this.sessionToken === session) {
          if (initialOffsetInChunk !== undefined) {
            const relative = initialOffsetInChunk - chunk.startOffset;
            const ratio = Math.max(0, Math.min(1, relative / chunk.text.length));
            this.audio.currentTime = ratio * this.audio.duration;
          }
          this.audio.play().catch(() => {});
        }
        this.audio.removeEventListener('loadedmetadata', onLoaded);
      };

      this.audio.addEventListener('loadedmetadata', onLoaded);
    } catch (err) {
      console.error("Audio playback failed, falling back to Web Speech:", err);
      // Optional: Add Web Speech fallback logic here if desired
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
    if (this.audio.src) {
      URL.revokeObjectURL(this.audio.src);
      this.audio.src = "";
    }
    this.synth.cancel();
  }

  get isPaused() {
    return this.audio.paused;
  }
}

export const speechController = new SpeechController();