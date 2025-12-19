import { Rule, RuleType } from '../types';

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

/**
 * Capacitor Bridge Interface
 * Logic to communicate with Native Android Foreground Service if available.
 */
const Capacitor = (window as any).Capacitor;
const NativeTTS = Capacitor?.Plugins?.NativeTTS;

class SpeechController {
  private synth: SpeechSynthesis;
  private chunks: SpeechChunk[] = [];
  private currentChunkIndex: number = -1;
  private onEndCallback: (() => void) | null = null;
  private globalBoundaryCallback: ((offset: number, charIndex: number, chunkIdx: number) => void) | null = null;
  private rate: number = 1.0;
  private voiceName: string = '';
  private sessionToken: number = 0;
  private getNextSegment: (() => Promise<NextSegment | null>) | null = null;
  private currentPrefixLength: number = 0;
  private totalTextLength: number = 0;
  
  // Highlighting: Velocity Engine
  private lastEventTime: number = 0;
  private lastEventOffset: number = 0;
  private highlightTimer: number | null = null;
  
  // Power & Stability
  private wakeLock: any = null;
  private isNativeMode: boolean = !!NativeTTS;

  constructor() {
    this.synth = window.speechSynthesis;
    this.setupMediaSession();
  }

  private setupMediaSession() {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => {
          if (this.isNativeMode) NativeTTS.resume();
          else if (this.synth.paused) {
            this.synth.resume();
            this.updatePlaybackState('playing');
          }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (this.isNativeMode) NativeTTS.pause();
          else {
            this.synth.pause();
            this.updatePlaybackState('paused');
          }
        });
        navigator.mediaSession.setActionHandler('stop', () => this.stop());
      } catch (e) {}
    }
  }

  private updatePlaybackState(state: 'playing' | 'paused' | 'none') {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
  }

  private async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
      } catch (err) {}
    }
  }

  private releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().then(() => { this.wakeLock = null; });
    }
  }

  private createChunks(text: string): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    const MAX_CHUNK_LENGTH = 800; // Small chunks reduce impact of skips
    const segments = text.split(/([.!?\n]\s*)/);
    let tempChunk = "";
    let tempStart = 0;

    segments.forEach(s => {
      if (tempChunk.length + s.length > MAX_CHUNK_LENGTH) {
        if (tempChunk) chunks.push({ text: tempChunk, startOffset: tempStart });
        tempStart += tempChunk.length;
        tempChunk = s;
      } else {
        tempChunk += s;
      }
    });
    if (tempChunk) chunks.push({ text: tempChunk, startOffset: tempStart });
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
    bookTitle: string = "Unknown Book",
    chapterTitle: string = "Unknown Chapter"
  ) {
    this.sessionToken++;
    const currentSession = this.sessionToken;
    this.stopHighlightTracker();
    this.requestWakeLock();
    
    this.onEndCallback = onEnd;
    this.globalBoundaryCallback = onBoundary || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;
    this.currentPrefixLength = 0;
    this.totalTextLength = text.length;

    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapterTitle,
        artist: bookTitle,
        artwork: [{ src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png', sizes: '512x512', type: 'image/png' }]
      });
    }

    if (this.isNativeMode) {
      // Logic for Capacitor Native TTS with Foreground Service
      NativeTTS.speak({
        text: text.substring(startOffset),
        rate: this.rate,
        voice: this.voiceName,
        title: chapterTitle,
        artist: bookTitle
      });
      // Boundary events would come back via plugin listeners
      return;
    }

    this.synth.cancel();
    this.updatePlaybackState('playing');

    const fullChunks = this.createChunks(text);
    this.chunks = fullChunks.filter(c => c.startOffset + c.text.length > startOffset);
    
    if (this.chunks.length > 0) {
      this.currentChunkIndex = 0;
      const firstChunk = this.chunks[0];
      if (startOffset > firstChunk.startOffset) {
        const diff = startOffset - firstChunk.startOffset;
        this.chunks[0] = { text: firstChunk.text.substring(diff), startOffset: startOffset };
      }
      this.speakNextChunk(currentSession);
    } else if (onEnd) onEnd();
  }

  private startHighlightTracker(session: number, baseOffset: number) {
    this.stopHighlightTracker();
    this.lastEventOffset = baseOffset;
    this.lastEventTime = performance.now();

    // Accuracy boost: chars per millisecond
    const velocity = (0.016 * this.rate); 

    this.highlightTimer = window.setInterval(() => {
      if (this.sessionToken !== session || this.synth.paused) return;

      const elapsed = performance.now() - this.lastEventTime;
      const predictedOffset = Math.floor(this.lastEventOffset + (elapsed * velocity));

      if (this.globalBoundaryCallback) {
        const effective = Math.max(0, predictedOffset - this.currentPrefixLength);
        if (effective < this.totalTextLength) {
          // Send update every tick for smooth UI transition
          this.globalBoundaryCallback(effective, 0, this.currentChunkIndex);
        }
      }
    }, 100); // 10Hz updates for smooth highlights
  }

  private stopHighlightTracker() {
    if (this.highlightTimer) {
      clearInterval(this.highlightTimer);
      this.highlightTimer = null;
    }
  }

  private async speakNextChunk(session: number) {
    if (this.sessionToken !== session) return;

    if (this.currentChunkIndex >= this.chunks.length) {
      this.stopHighlightTracker();
      
      // Strict Skip Guard: Never transition chapters in hidden state on web
      if (document.hidden) {
        console.warn("[Speech] Background auto-advance prevented.");
        this.updatePlaybackState('paused');
        if (this.onEndCallback) this.onEndCallback();
        return;
      }

      if (this.getNextSegment) {
        const next = await this.getNextSegment();
        if (next && this.sessionToken === session) {
          this.currentPrefixLength = next.announcementPrefix.length;
          this.totalTextLength = next.content.length;
          this.chunks = this.createChunks(next.announcementPrefix + next.content);
          this.currentChunkIndex = 0;
          this.speakNextChunk(session);
          return;
        }
      }
      this.updatePlaybackState('none');
      if (this.onEndCallback) this.onEndCallback();
      return;
    }

    const chunk = this.chunks[this.currentChunkIndex];
    if (!chunk.text.trim()) {
      this.currentChunkIndex++;
      this.speakNextChunk(session);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunk.text);
    const voices = this.synth.getVoices();
    const voice = voices.find(v => v.name === this.voiceName) || voices.find(v => v.lang.startsWith('en')) || voices[0];
    if (voice) utterance.voice = voice;
    utterance.rate = this.rate;

    const chunkStartTime = performance.now();
    const expectedDuration = (chunk.text.length / (0.016 * this.rate)); // Estimate min duration

    this.startHighlightTracker(session, chunk.startOffset);

    utterance.onboundary = (event) => {
      if (this.sessionToken === session && typeof event.charIndex === 'number') {
        const currentGlobal = chunk.startOffset + event.charIndex;
        this.lastEventOffset = currentGlobal;
        this.lastEventTime = performance.now();
      }
    };

    utterance.onend = () => {
      if (this.sessionToken !== session) return;

      // Anti-Glitch Lock: If chunk "finishes" in less than 20% of estimated time, it's a browser skip.
      const actualDuration = performance.now() - chunkStartTime;
      if (actualDuration < expectedDuration * 0.2 && chunk.text.length > 20) {
        console.error("[Speech] Glitch skip detected. Freezing at current offset.");
        this.stop();
        if (this.onEndCallback) this.onEndCallback();
        return;
      }

      this.currentChunkIndex++;
      this.speakNextChunk(session);
    };

    utterance.onerror = (e) => {
      if (this.sessionToken === session) {
        this.currentChunkIndex++;
        this.speakNextChunk(session);
      }
    };

    this.synth.speak(utterance);
  }

  stop() {
    this.sessionToken++; 
    this.stopHighlightTracker();
    this.releaseWakeLock();
    if (this.isNativeMode) NativeTTS.stop();
    else {
      this.synth.cancel();
      this.updatePlaybackState('none');
    }
    this.chunks = [];
    this.currentChunkIndex = -1;
  }

  get isPaused() { return this.synth.paused; }
}

export const speechController = new SpeechController();