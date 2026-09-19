import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface LiveWaveformProps {
  /** The live mic stream. Reacts to whatever the mic is picking up, whether the
   * recorder is actively recording or paused — the stream itself stays open either way. */
  stream: MediaStream | null;
  className?: string;
}

const BAR_COUNT = 40;

/** Live-updating bar graph of the mic input, so a doctor can see the mic is actually
 * picking up speech. Draws from a Web Audio AnalyserNode fed by the same MediaStream
 * getUserMedia already returned — no separate mic access. */
export function LiveWaveform({ stream, className }: LiveWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = canvas!.clientWidth * dpr;
      canvas!.height = canvas!.clientHeight * dpr;
    }
    resize();

    if (!stream) {
      // No live input — draw a flat idle line instead of an empty canvas.
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = "currentColor";
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const color = getComputedStyle(canvas).color;

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let raf = 0;
    function draw() {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const { width, height } = canvas!;
      ctx!.clearRect(0, 0, width, height);
      ctx!.globalAlpha = 1;
      ctx!.fillStyle = color;
      const step = Math.max(1, Math.floor(data.length / BAR_COUNT));
      const gap = width / BAR_COUNT;
      const barWidth = Math.max(1, gap * 0.6);
      for (let i = 0; i < BAR_COUNT; i++) {
        const value = data[i * step] / 255;
        const barHeight = Math.max(height * 0.05, value * height);
        const x = i * gap + (gap - barWidth) / 2;
        ctx!.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
      }
    }
    draw();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      source.disconnect();
      analyser.disconnect();
      audioCtx.close();
    };
  }, [stream]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("h-16 w-full text-primary", className)}
    />
  );
}
