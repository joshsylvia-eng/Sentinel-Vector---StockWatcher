'use strict';

/*
 * Every alert tone is synthesised with the Web Audio API, so there are no sound
 * files to ship. Each rating in Settings can pick any of these motifs.
 */
(() => {
  let context = null;
  let lastPlayed = null;

  function audio() {
    if (!context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      context = new AudioCtor();
    }
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  function tone({
    frequency,
    at = 0,
    duration = 0.2,
    type = 'sine',
    peak = 0.14,
    sweepTo = null,
  }) {
    const ctx = audio();
    if (!ctx) return;

    const start = ctx.currentTime + at;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (sweepTo) oscillator.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.06);
  }

  /* ---------- motifs ---------- */

  // Bright rising major arpeggio.
  function arpeggio() {
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      tone({ frequency, at: index * 0.105, duration: 0.17, peak: 0.15 });
    });
    tone({ frequency: 1046.5, at: 0.315, duration: 0.42, peak: 0.13 });
  }

  // Soft bell: fundamentals with quiet upper partials.
  function chime() {
    const notes = [
      { frequency: 880, at: 0 },
      { frequency: 1108.73, at: 0.2 },
    ];
    for (const note of notes) {
      tone({ frequency: note.frequency, at: note.at, duration: 0.85, peak: 0.12 });
      tone({ frequency: note.frequency * 1.5, at: note.at + 0.01, duration: 0.5, peak: 0.05 });
      tone({ frequency: note.frequency * 2, at: note.at + 0.02, duration: 0.32, peak: 0.03 });
    }
  }

  // Short, quiet woodblock tick — good for Neutral.
  function tick() {
    tone({ frequency: 1250, at: 0, duration: 0.045, type: 'triangle', peak: 0.09 });
    tone({ frequency: 900, at: 0.085, duration: 0.05, type: 'triangle', peak: 0.07 });
  }

  // Muted three-note pulse.
  function pulse() {
    [330, 262, 196].forEach((frequency, index) => {
      tone({
        frequency,
        at: index * 0.13,
        duration: 0.22,
        type: 'triangle',
        peak: 0.11,
      });
    });
  }

  // Low descending buzz.
  function buzz() {
    tone({ frequency: 320, at: 0, duration: 0.62, type: 'sawtooth', peak: 0.1, sweepTo: 146.83 });
    tone({ frequency: 213, at: 0.16, duration: 0.55, type: 'square', peak: 0.05, sweepTo: 96 });
    tone({ frequency: 160, at: 0.34, duration: 0.42, type: 'sawtooth', peak: 0.07, sweepTo: 82 });
  }

  // Quick digital blips.
  function digital() {
    [660, 880, 990, 1320].forEach((frequency, index) => {
      tone({ frequency, at: index * 0.065, duration: 0.07, type: 'square', peak: 0.055 });
    });
  }

  function silent() {
    // deliberately nothing
  }

  const MOTIFS = {
    arpeggio,
    chime,
    tick,
    pulse,
    buzz,
    digital,
    none: silent,
  };

  function play(soundId) {
    const id = MOTIFS[soundId] ? soundId : 'arpeggio';
    lastPlayed = id;
    MOTIFS[id]();
  }

  const ORDER = ['strongBuy', 'buy', 'neutral', 'sell', 'strongSell'];

  function previewAll(sounds) {
    const source = sounds || {};
    ORDER.forEach((key, index) => {
      setTimeout(() => play(source[key] || 'arpeggio'), index * 650);
    });
  }

  window.Sounds = {
    play,
    preview: play,
    previewAll,
    unlock: audio,
    lastPlayed: () => lastPlayed,
  };
})();
