import { Rule, RuleType } from '../types';
import { synthesizeChunk } from './cloudTtsService';

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

class SpeechController {
  private synth: SpeechSynthesis;
  private audio: HTMLAudioElement;
  private currentChunks: SpeechChunk[] = [];
  private currentChunkIndex: number = -1;
  private timer: number | null = null;
  
  private onEndCallback: (() => void) | null = null;
  private globalBoundaryCallback: ((offset: number, charIndex: number, chunkIdx: number) => void) | null = null;
  
  private rate: number = 1.0;
  private voiceName: string = '';
  private sessionToken: number = 0;
  private getNextSegment: (() => Promise<NextSegment | null>) | null = null;
  
  // Defensive access to environment variables to prevent crash if import.meta or env is missing
  private isCloudEnabled: boolean = !!(typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TTS_ENDPOINT);

  constructor() {
    this.synth = window.speechSynthesis;
    this.audio = new Audio();
    this.setupAudioListeners();
    this.setupMediaSession();
  }

  private setupAudioListeners() {
    this.audio.addEventListener('ended', () => {
      this.currentChunkIndex++;
      this.playNextChunk();
    });

    this.audio.addEventListener('play', () => {
      this.startTracking();
      this.updateMediaSessionState();
    });

    this.audio.addEventListener('pause', () => {
      this.stopTracking();
      this.updateMediaSessionState();
    });

    this.audio.addEventListener('error', (e) => {
      console.error("Audio error, fallback to WebSpeech:", e);
      this.isCloudEnabled = false;
      this.playNextChunk();
    });
  }

  private setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.resume());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('stop', () => this.stop());
    }
  }

  private updateMediaSessionState() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
      if ((navigator as any).mediaSession.setPositionState && this.audio.duration) {
        try {
          (navigator as any).mediaSession.setPositionState({
            duration: this.audio.duration,
            playbackRate: this.audio.playbackRate,
            position: this.audio.currentTime,
          });
        } catch (e) {}
      }
    }
  }

  private startTracking() {
    this.stopTracking();
    this.timer = window.setInterval(() => {
      if (this.globalBoundaryCallback && this.currentChunkIndex >= 0) {
        const chunk = this.currentChunks[this.currentChunkIndex];
        if (!chunk || !this.audio.duration) return;
        
        const ratio = this.audio.currentTime / this.audio.duration;
        const charOffset = Math.floor(chunk.text.length * ratio);
        this.globalBoundaryCallback(chunk.startOffset + charOffset, charOffset, this.currentChunkIndex);
      }
    }, 120);
  }

  private stopTracking() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private createChunks(text: string): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    const MAX = this.isCloudEnabled ? 5000 : 800;
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
    onBoundary?: (offset: number, charIndex: number, chunkIdx: number) => void,
    getNextSegment?: () => Promise<NextSegment | null>,
    bookTitle?: string,
    chapterTitle?: string
  ) {
    this.sessionToken++;
    this.stop();
    
    this.onEndCallback = onEnd;
    this.globalBoundaryCallback = onBoundary || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;

    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapterTitle || "Talevox",
        artist: bookTitle || "TTS Reader",
        artwork: [{ src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png', sizes: '512x512', type: 'image/png' }]
      });
    }

    this.currentChunks = this.createChunks(text);
    
    // Find starting chunk
    const idx = this.currentChunks.findIndex(c => c.startOffset + c.text.length > startOffset);
    this.currentChunkIndex = idx !== -1 ? idx : 0;

    this.playNextChunk(startOffset);
  }

  /**
   * Specialized seek that avoids a full re-fetch if we are already in the correct chunk.
   */
  seekToOffset(offset: number) {
    if (this.currentChunks.length === 0) return;
    const idx = this.currentChunks.findIndex(c => c.startOffset + c.text.length > offset);
    if (idx === -1) return;

    if (this.isCloudEnabled && idx === this.currentChunkIndex && this.audio.src && this.audio.duration) {
      const chunk = this.currentChunks[idx];
      const relative = offset - chunk.startOffset;
      const ratio = Math.max(0, Math.min(1, relative / chunk.text.length));
      this.audio.currentTime = ratio * this.audio.duration;
    } else {
      // Different chunk or legacy mode, full restart required
      this.currentChunkIndex = idx;
      this.playNextChunk(offset);
    }
  }

  private async playNextChunk(initialOffsetInChunk?: number) {
    const session = this.sessionToken;

    if (this.currentChunkIndex >= this.currentChunks.length) {
      if (document.hidden) {
        this.pause(); // Do not advance chapters if the app is minimized
        return;
      }
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
    
    if (this.isCloudEnabled) {
      try {
        const result = await synthesizeChunk(chunk.text, this.voiceName, this.rate);
        if (this.sessionToken !== session) return;
        
        this.audio.src = result.audioUrl;
        
        if (initialOffsetInChunk !== undefined) {
          const relative = initialOffsetInChunk - chunk.startOffset;
          const ratio = Math.max(0, Math.min(1, relative / chunk.text.length));
          
          this.audio.onloadedmetadata = () => {
            if (this.sessionToken === session) {
                this.audio.currentTime = ratio * this.audio.duration;
                this.audio.play().catch(() => {});
            }
            this.audio.onloadedmetadata = null;
          };
        } else {
          this.audio.play().catch(() => {});
        }
      } catch (err) {
        console.warn("Cloud TTS failed, falling back to WebSpeech:", err);
        this.isCloudEnabled = false;
        this.playNextChunk(initialOffsetInChunk);
      }
    } else {
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      const voices = this.synth.getVoices();
      utterance.voice = voices.find(v => v.name === this.voiceName) || voices[0];
      utterance.rate = this.rate;

      utterance.onboundary = (event) => {
        if (this.sessionToken === session && this.globalBoundaryCallback) {
          this.globalBoundaryCallback(chunk.startOffset + event.charIndex, event.charIndex, this.currentChunkIndex);
        }
      };

      utterance.onend = () => {
        if (this.sessionToken === session) {
          this.currentChunkIndex++;
          this.playNextChunk();
        }
      };

      this.synth.speak(utterance);
    }
  }

  pause() {
    if (this.isCloudEnabled) this.audio.pause();
    else this.synth.pause();
  }

  resume() {
    if (this.isCloudEnabled) this.audio.play().catch(() => {});
    else this.synth.resume();
  }

  stop() {
    this.sessionToken++;
    this.stopTracking();
    this.audio.pause();
    if (this.audio.src) {
      URL.revokeObjectURL(this.audio.src);
      this.audio.src = "";
    }
    this.synth.cancel();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  }

  get isPaused() {
    return this.isCloudEnabled ? this.audio.paused : this.synth.paused;
  }
}

export const speechController = new SpeechController();