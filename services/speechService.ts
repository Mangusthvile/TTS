
import { Rule, CaseMode } from '../types';

export function applyRules(text: string, rules: Rule[]): string {
  let processedText = text;
  const activeRules = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  activeRules.forEach(rule => {
    let flags = 'g';
    if (rule.caseMode === CaseMode.IGNORE) flags += 'i';
    
    let pattern = rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (rule.wholeWord) pattern = `\\b${pattern}\\b`;

    try {
      const regex = new RegExp(pattern, flags);
      if (rule.caseMode === CaseMode.SMART) {
        processedText = processedText.replace(regex, (match) => {
          if (match[0] === match[0].toUpperCase()) {
            return rule.speakAs[0].toUpperCase() + rule.speakAs.slice(1);
          }
          return rule.speakAs;
        });
      } else {
        processedText = processedText.replace(regex, rule.speakAs);
      }
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
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private totalTextLength: number = 0;

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
        navigator.mediaSession.setActionHandler('previoustrack', () => {
           // Handled by App state via UI but can be mapped here if needed
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
           // Handled by App state via UI but can be mapped here if needed
        });
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          const skip = details.seekOffset || 500;
          // Custom seek logic would need global state access, usually handled via UI events
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          const skip = details.seekOffset || 500;
        });
      } catch (e) {
        console.warn("MediaSession handlers could not be set", e);
      }
    }
  }

  private updateMediaMetadata(title: string, artist: string) {
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title,
          artist: artist,
          album: 'Talevox Library',
          artwork: [
            { src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png', sizes: '512x512', type: 'image/png' }
          ]
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
    const paragraphs = text.split(/(\n\s*\n)/);
    
    let tempChunk = "";
    let tempStart = 0;

    paragraphs.forEach(p => {
      if (tempChunk.length + p.length > MAX_CHUNK_LENGTH) {
        if (p.length > MAX_CHUNK_LENGTH) {
           if (tempChunk) {
              chunks.push({ text: tempChunk, startOffset: tempStart });
              tempStart += tempChunk.length;
              tempChunk = "";
           }
           const sentences = p.split(/([.!?]\s+)/);
           sentences.forEach(s => {
              if (tempChunk.length + s.length > MAX_CHUNK_LENGTH) {
                 if (tempChunk) chunks.push({ text: tempChunk, startOffset: tempStart });
                 tempStart += tempChunk.length;
                 tempChunk = s;
              } else {
                 tempChunk += s;
              }
           });
        } else {
          if (tempChunk) chunks.push({ text: tempChunk, startOffset: tempStart });
          tempStart += tempChunk.length;
          tempChunk = p;
        }
      } else {
        tempChunk += p;
      }
    });
    if (tempChunk) chunks.push({ text: tempChunk, startOffset: tempStart });
    return chunks;
  }

  setRate(rate: number) { this.rate = rate; }
  setVoice(voiceName: string) { this.voiceName = voiceName; }

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
    
    // Stop any existing speech immediately
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
    
    const fullChunks = this.createChunks(text);
    this.chunks = fullChunks.filter(c => c.startOffset + c.text.length > startOffset);
    
    if (this.chunks.length > 0) {
      this.currentChunkIndex = 0;
      const firstChunk = this.chunks[0];
      if (startOffset > firstChunk.startOffset) {
        const diff = startOffset - firstChunk.startOffset;
        this.chunks[0] = { text: firstChunk.text.substring(diff), startOffset: startOffset };
      }
      
      // Chaining start: Use minimal delay to ensure background process isn't interrupted by a long silence
      this.speakNextChunk(currentSession);
    } else {
      if (onEnd) onEnd();
    }
  }

  private async speakNextChunk(session: number) {
    if (this.sessionToken !== session) return;

    if (this.currentChunkIndex >= this.chunks.length) {
      if (this.getNextSegment) {
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
    this.currentUtterance = utterance; // Keep reference to avoid GC
    
    const voices = this.synth.getVoices();
    const voice = voices.find(v => v.name === this.voiceName) || 
                  voices.find(v => v.lang.startsWith('en')) || 
                  (voices.length > 0 ? voices[0] : null);

    if (voice) {
      utterance.voice = voice;
    }
    
    utterance.rate = this.rate;

    utterance.onboundary = (event) => {
      if (this.sessionToken === session && this.globalBoundaryCallback && typeof event.charIndex === 'number') {
        const totalOffset = chunk.startOffset + event.charIndex;
        const effectiveOffset = Math.max(0, totalOffset - this.currentPrefixLength);
        this.globalBoundaryCallback(effectiveOffset, event.charIndex, this.currentChunkIndex);
        
        // Update Media Position State if supported
        if ('mediaSession' in navigator && (navigator.mediaSession as any).setPositionState) {
          try {
            const progress = effectiveOffset / Math.max(1, this.totalTextLength);
            // Artificial duration estimation for lockscreen progress bar
            const estDuration = (this.totalTextLength / 170) * 60; 
            (navigator.mediaSession as any).setPositionState({
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
      this.currentUtterance = null;
      this.currentChunkIndex++;
      // Immediate chaining is critical for mobile background playback
      this.speakNextChunk(session);
    };

    utterance.onerror = (event: any) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      console.error(`Speech Synthesis Error: ${event.error}`);
      if (this.sessionToken === session) {
        this.currentUtterance = null;
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
    this.currentUtterance = null;
    
    this.synth.cancel();
    this.updatePlaybackState('none');

    this.chunks = [];
    this.currentChunkIndex = -1;
  }

  get isPaused() { return this.synth.paused; }
}

export const speechController = new SpeechController();
