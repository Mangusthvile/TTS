
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

  constructor() {
    this.synth = window.speechSynthesis;
    this.setupMediaSession();
  }

  private setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.resumeFromMediaSession());
      navigator.mediaSession.setActionHandler('pause', () => this.pauseFromMediaSession());
      navigator.mediaSession.setActionHandler('stop', () => this.stop());
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const skip = details.seekOffset || 500;
        this.seekRelative(-skip);
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const skip = details.seekOffset || 500;
        this.seekRelative(skip);
      });
      // Placeholder next/prev handlers that usually trigger a callback to App
      navigator.mediaSession.setActionHandler('nexttrack', () => { /* No-op, managed by auto-advance logic */ });
      navigator.mediaSession.setActionHandler('previoustrack', () => { /* No-op */ });
    }
  }

  private seekRelative(delta: number) {
    // Media session seek is context dependent, usually we emit an event or call back
    // For now we assume we can find the current play callback in App.tsx
  }

  private resumeFromMediaSession() {
    // If truly paused at system level
    if (this.synth.paused) {
      this.synth.resume();
      this.updatePlaybackState('playing');
    }
  }

  private pauseFromMediaSession() {
    if (this.synth.speaking) {
      this.synth.pause();
      this.updatePlaybackState('paused');
    }
  }

  private updateMediaMetadata(title: string, artist: string) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: 'Talevox Library'
      });
    }
  }

  private updatePlaybackState(state: 'playing' | 'paused' | 'none') {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
  }

  private createChunks(text: string): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    const MAX_CHUNK_LENGTH = 1800; 
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
    
    this.synth.cancel();
    
    this.onEndCallback = onEnd;
    this.globalBoundaryCallback = onBoundary || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;
    this.currentPrefixLength = 0;
    this.currentBookTitle = bookTitle;
    this.currentChapterTitle = chapterTitle;

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
      this.speakNextChunk(currentSession);
    } else {
      onEnd();
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
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    const voices = this.synth.getVoices();
    const voice = voices.find(v => v.name === this.voiceName) || voices.find(v => v.lang.startsWith('en')) || voices[0];
    
    if (voice) utterance.voice = voice;
    utterance.rate = this.rate;

    utterance.onboundary = (event) => {
      if (this.sessionToken === session && this.globalBoundaryCallback && typeof event.charIndex === 'number') {
        const totalOffset = chunk.startOffset + event.charIndex;
        const effectiveOffset = Math.max(0, totalOffset - this.currentPrefixLength);
        this.globalBoundaryCallback(effectiveOffset, event.charIndex, this.currentChunkIndex);
        
        // Update position state for better lock screen progress
        if ('mediaSession' in navigator && (navigator as any).mediaSession.setPositionState) {
          try {
            (navigator as any).mediaSession.setPositionState({
              duration: 100, // Percentage based or estimated seconds. Here dummy 100 as proxy.
              playbackRate: this.rate,
              position: Math.min(100, (effectiveOffset / chunk.text.length) * 100)
            });
          } catch(e) {}
        }
      }
    };

    utterance.onend = () => {
      if (this.sessionToken !== session) return;
      // IMMEDIATE chaining for background stability
      this.currentChunkIndex++;
      this.speakNextChunk(session);
    };

    utterance.onerror = (err) => {
      console.error("Speech Error:", err);
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
    this.updatePlaybackState('none');

    this.chunks = [];
    this.currentChunkIndex = -1;
  }

  get isPaused() { return this.synth.paused; }
}

export const speechController = new SpeechController();
