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
 * Android Media Session Anchor
 * Samsung devices kill background JS if no "Audio Context" is active.
 * We create a "Heartbeat" that plays extreme low-volume noise to stay alive.
 */
class AndroidHeartbeat {
  private ctx: AudioContext | null = null;
  private noiseNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;

  start() {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();

      this.stop();

      // Generating white noise at 0.0001 volume
      const bufferSize = 4096;
      this.noiseNode = this.ctx.createScriptProcessor(bufferSize, 1, 1);
      this.noiseNode.onaudioprocess = (e) => {
        const output = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          output[i] = (Math.random() * 2 - 1) * 0.0001;
        }
      };

      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.01; // Final volume is basically 0
      
      this.noiseNode.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      console.debug("[Heartbeat] Started Android background anchor.");
    } catch (e) {
      console.warn("Heartbeat failed:", e);
    }
  }

  stop() {
    if (this.noiseNode) {
      this.noiseNode.disconnect();
      this.noiseNode = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
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
  private totalTextLength: number = 0;
  private heartbeat: AndroidHeartbeat = new AndroidHeartbeat();
  
  // Highlighting: Synthetic Position Tracker
  private lastEventTime: number = 0;
  private lastEventOffset: number = 0;
  private highlightTimer: number | null = null;

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
          this.synth.pause();
          this.updatePlaybackState('paused');
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

  private createChunks(text: string): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    const MAX_CHUNK_LENGTH = 1000; // Even smaller chunks for mobile stability
    // Split by sentences or newlines
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
    this.stopHighlightTracker();
    
    this.onEndCallback = onEnd;
    this.globalBoundaryCallback = onBoundary || null;
    this.rate = rate;
    this.voiceName = voiceName;
    this.getNextSegment = getNextSegment || null;
    this.currentPrefixLength = 0;
    this.totalTextLength = text.length;

    // Update Media Session
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapterTitle,
        artist: bookTitle,
        artwork: [{ src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png', sizes: '512x512', type: 'image/png' }]
      });
    }

    this.heartbeat.start();
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

  /**
   * Start the "Synthetic Highlighting" engine.
   * Mobile browsers rarely fire boundary events. This timer predicts where the voice is
   * and moves the highlight even if the engine is silent.
   */
  private startHighlightTracker(session: number, baseOffset: number) {
    this.stopHighlightTracker();
    this.lastEventOffset = baseOffset;
    this.lastEventTime = Date.now();

    // Approx characters per millisecond at 1.0 rate (~18 chars/sec)
    const velocity = (0.018 * this.rate); 

    this.highlightTimer = window.setInterval(() => {
      if (this.sessionToken !== session || this.synth.paused) return;

      const elapsed = Date.now() - this.lastEventTime;
      const predictedOffset = Math.floor(this.lastEventOffset + (elapsed * velocity));

      if (this.globalBoundaryCallback) {
        const effective = Math.max(0, predictedOffset - this.currentPrefixLength);
        if (effective < this.totalTextLength) {
          this.globalBoundaryCallback(effective, 0, this.currentChunkIndex);
        }
      }
    }, 120);
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
      
      // Verification: If tab is hidden, DON'T advance chapter. 
      // This is the primary fix for the "skip forward when phone is closed" bug.
      if (document.hidden) {
        console.warn("[Speech] Background auto-advance blocked for safety.");
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

    const chunkStartTime = Date.now();
    this.startHighlightTracker(session, chunk.startOffset);

    utterance.onboundary = (event) => {
      if (this.sessionToken === session && typeof event.charIndex === 'number') {
        const currentGlobal = chunk.startOffset + event.charIndex;
        // Re-sync synthetic tracker
        this.lastEventOffset = currentGlobal;
        this.lastEventTime = Date.now();

        if (this.globalBoundaryCallback) {
          this.globalBoundaryCallback(Math.max(0, currentGlobal - this.currentPrefixLength), event.charIndex, this.currentChunkIndex);
        }
      }
    };

    utterance.onend = () => {
      if (this.sessionToken !== session) return;

      // Temporal Verification: If chunk "finished" impossibly fast, it was a system skip.
      const duration = Date.now() - chunkStartTime;
      if (duration < 50 && chunk.text.length > 10) {
        console.error("[Speech] Sudden skip detected. Emergency pause.");
        this.stop();
        if (this.onEndCallback) this.onEndCallback();
        return;
      }

      this.currentChunkIndex++;
      this.speakNextChunk(session);
    };

    utterance.onerror = (e) => {
      console.warn("[Speech] Utterance Error:", e);
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
    this.globalBoundaryCallback = null;
    this.onEndCallback = null;
    this.getNextSegment = null;
    this.synth.cancel();
    this.heartbeat.stop();
    this.updatePlaybackState('none');
    this.chunks = [];
    this.currentChunkIndex = -1;
  }

  get isPaused() { return this.synth.paused; }
}

export const speechController = new SpeechController();