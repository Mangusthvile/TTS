
import { Rule, CaseMode, Scope } from '../types';

export function applyRules(text: string, rules: Rule[]): string {
  let processedText = text;
  
  // Sort rules by priority descending
  const activeRules = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  activeRules.forEach(rule => {
    let flags = 'g';
    if (rule.caseMode === CaseMode.IGNORE) flags += 'i';
    
    let pattern = rule.find;
    
    // Escape regex characters
    pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (rule.wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const regex = new RegExp(pattern, flags);

    if (rule.caseMode === CaseMode.SMART) {
      processedText = processedText.replace(regex, (match) => {
        // If match starts with uppercase, try to make replacement start with uppercase
        if (match[0] === match[0].toUpperCase()) {
          return rule.speakAs[0].toUpperCase() + rule.speakAs.slice(1);
        }
        return rule.speakAs;
      });
    } else {
      processedText = processedText.replace(regex, rule.speakAs);
    }
  });

  return processedText;
}

class SpeechController {
  private synth: SpeechSynthesis;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private onEndCallback: (() => void) | null = null;

  constructor() {
    this.synth = window.speechSynthesis;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.synth.getVoices();
  }

  speak(text: string, voiceName: string, rate: number, onEnd: () => void, onBoundary?: (offset: number) => void) {
    this.stop();
    
    this.onEndCallback = onEnd;
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = this.getVoices();
    const voice = voices.find(v => v.name === voiceName) || voices[0];
    
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    
    utterance.onend = () => {
      if (this.onEndCallback) this.onEndCallback();
    };

    utterance.onboundary = (event) => {
      if (event.name === 'word' && onBoundary) {
        onBoundary(event.charIndex);
      }
    };

    this.currentUtterance = utterance;
    this.synth.speak(utterance);
  }

  pause() {
    this.synth.pause();
  }

  resume() {
    this.synth.resume();
  }

  stop() {
    this.onEndCallback = null;
    this.synth.cancel();
  }

  get isPaused() {
    return this.synth.paused;
  }

  get isSpeaking() {
    return this.synth.speaking;
  }
}

export const speechController = new SpeechController();
