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
 * Silent Audio Keeper
 * Mobile browsers suspend speech synthesis when the app is in background.
 * Playing a silent audio loop tricks the OS into keeping the tab alive as a media source.
 */
class BackgroundKeeper {
  private audioContext: AudioContext | null = null;
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;

  start() {
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
      
      this.stop(); // Clear any existing

      this.oscillator = this.audioContext.createOscillator();
      this.gain = this.audioContext.createGain();
      
      this.oscillator.type = 'sine';
      this.oscillator.frequency.setValueAtTime(1, this.audioContext.currentTime); // 1Hz - inaudible
      this.gain.gain.setValueAtTime(0.001, this.audioContext.currentTime); // Extremely low volume
      
      this.oscillator.connect(this.gain);
      this.gain.connect(this.audioContext.destination);
      this.oscillator.start();
    } catch (e) {
      console.warn("BackgroundKeeper failed to start", e);
    }
  }

  stop() {
    if (this.oscillator) {
      try {
        this.oscillator.stop();
        this.oscillator.disconnect();
      } catch (e) {}
      this.oscillator = null;
    }
  }
}

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
  private currentBookTitle: string = "";
  private currentChapterTitle: string = "";
  private totalTextLength: number = 0;
  private backgroundKeeper: BackgroundKeeper = new BackgroundKeeper();
  private lastChunkStartTime: number = 0;

  constructor() {
    this.synth = window.speechSynthesis;
    this.setupMediaSession();
  }

  private setupMediaSession() {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => {
          if (this.synth.paused) {
            this.synth.resume();
            this.updatePlaybackState('playing');
          }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (this.synth.speaking) {
            this.synth.pause();
            this.updatePlaybackState('paused');
          }
        });
        navigator.mediaSession.setActionHandler('stop', () => this.stop());
      } catch (e) {}
    }
  }

  private updateMediaMetadata(title: string, artist: string) {
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title,
          artist: artist,
          album: 'Talevox Library',
          artwork: [{ src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png', sizes: '512x512', type: 'image/png' }]
        });
      } catch (e) {}
    }
  }

  private updatePlaybackState(state: 'playing' | 'paused' | 'none') {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
  }

  private createChunks(text: string): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    const MAX_CHUNK_LENGTH = 1600; 
    const segments = text.split(/([.!?]\s+)/);
    
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

  speak(
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
    this.synth.cancel();
    
    this.onEndCallback = onEnd;
    this.globalBoundaryCallback = onBoundary || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;
    this.currentPrefixLength = 0;
    this.currentBookTitle = bookTitle;
    this.currentChapterTitle = chapterTitle;
    this.totalTextLength = text.length;

    this.updateMediaMetadata(chapterTitle, bookTitle);
    this.updatePlaybackState('playing');
    
    // Start background keeper for mobile
    this.backgroundKeeper.start();

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

  private async speakNextChunk(session: number) {
    if (this.sessionToken !== session) return;

    if (this.currentChunkIndex >= this.chunks.length) {
      if (this.getNextSegment) {
        /**
         * Mobile Guard: If the app is in background/locked and we hit the end of a chapter,
         * wait for foreground before transitioning to prevent "skipping" due to browser event floods.
         */
        if (document.hidden) {
           console.debug("[Speech] App hidden, waiting for visibility to transition chapter.");
           const handleVisibility = () => {
             if (!document.hidden) {
               document.removeEventListener('visibilitychange', handleVisibility);
               this.speakNextChunk(session);
             }
           };
           document.addEventListener('visibilitychange', handleVisibility);
           return;
        }

        const next = await this.getNextSegment();
        if (next && this.sessionToken === session) {
          this.currentPrefixLength = next.announcementPrefix.length;
          this.currentBookTitle = next.bookTitle;
          this.currentChapterTitle = next.chapterTitle;
          this.totalTextLength = next.content.length;
          this.updateMediaMetadata(next.chapterTitle, next.bookTitle);
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

    this.lastChunkStartTime = Date.now();

    utterance.onboundary = (event) => {
      if (this.sessionToken === session && this.globalBoundaryCallback && typeof event.charIndex === 'number') {
        const totalOffset = chunk.startOffset + event.charIndex;
        const effectiveOffset = Math.max(0, totalOffset - this.currentPrefixLength);
        this.globalBoundaryCallback(effectiveOffset, event.charIndex, this.currentChunkIndex);
        
        if ('mediaSession' in navigator && (navigator as any).setPositionState) {
          try {
            const progress = effectiveOffset / Math.max(1, this.totalTextLength);
            const estDuration = (this.totalTextLength / (170 * this.rate)) * 60; 
            (navigator as any).setPositionState({
              duration: estDuration,
              playbackRate: this.rate,
              position: estDuration * progress
            });
          } catch (e) {}
        }
      }
    };

    utterance.onend = () => {
      if (this.sessionToken !== session) return;

      // Suspension Guard: If chunks finish in less than 50ms, the system is likely skipping. Stop.
      if (Date.now() - this.lastChunkStartTime < 50 && chunk.text.length > 10) {
        console.warn("[Speech] System suspension detected (premature chunk end). Halting playback.");
        this.stop();
        if (this.onEndCallback) this.onEndCallback();
        return;
      }

      this.currentChunkIndex++;
      this.speakNextChunk(session);
    };

    utterance.onerror = () => {
      if (this.sessionToken === session) {
        this.currentChunkIndex++;
        this.speakNextChunk(session);
      }
    };

    this.synth.speak(utterance);
  }

  stop() {
    this.sessionToken++; 
    this.globalBoundaryCallback = null;
    this.onEndCallback = null;
    this.getNextSegment = null;
    this.synth.cancel();
    this.backgroundKeeper.stop();
    this.updatePlaybackState('none');
    this.chunks = [];
    this.currentChunkIndex = -1;
  }

  get isPaused() { return this.synth.paused; }
}

export const speechController = new SpeechController();