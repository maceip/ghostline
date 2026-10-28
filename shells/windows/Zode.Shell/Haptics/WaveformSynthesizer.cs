// Haptics/WaveformSynthesizer.cs — renders a haptic program to a PCM buffer.
//
// Windows desktops have no rich haptic API (contract §7), so the canonical
// programs are synthesised as audio: a sine carrier at the program's
// carrierHz with the amplitude taken from the intensity curve.  This is the
// same shape the web fallback shim produces with WebAudio, so "done" (triple
// roll) and "working" (tiny slow wave) stay recognisably different.

namespace Zode.Shell.Haptics;

internal static class WaveformSynthesizer
{
    /// <summary>Output sample rate of the synthesiser.</summary>
    public const int SampleRate = 48000;

    /// <summary>Master gain — keeps the synthesised haptics audible but gentle.</summary>
    public const float MasterGain = 0.32f;

    /// <summary>Longest transient rendered by the transient renderer, in ms.</summary>
    private const int TransientMaxMs = 60;

    public static float[] Synthesize(HapticProgram program)
    {
        int totalSamples = Math.Max(1, (int)Math.Round(program.DurationMs / 1000.0 * SampleRate));
        var buffer = new float[totalSamples];

        foreach (HapticTrack track in program.Tracks)
        {
            RenderTrack(buffer, track);
        }

        for (int i = 0; i < buffer.Length; i++)
        {
            buffer[i] = Math.Clamp(buffer[i], -1f, 1f);
        }

        return buffer;
    }

    private static void RenderTrack(float[] buffer, HapticTrack track)
    {
        if (track.IsTransient)
        {
            RenderTransient(buffer, track);
        }
        else
        {
            RenderContinuous(buffer, track);
        }
    }

    private static void RenderContinuous(float[] buffer, HapticTrack track)
    {
        int startSample = (int)Math.Round(track.StartMs / 1000.0 * SampleRate);
        int lengthSamples = (int)Math.Round(track.DurationMs / 1000.0 * SampleRate);
        if (lengthSamples <= 0)
        {
            return;
        }

        double phase = 0;
        double phaseStep = 2 * Math.PI * Math.Max(1.0, track.CarrierHz) / SampleRate;
        int rampSamples = Math.Max(1, (int)(0.005 * SampleRate)); // 5 ms attack / release

        for (int i = 0; i < lengthSamples; i++)
        {
            int index = startSample + i;
            if (index < 0 || index >= buffer.Length)
            {
                continue;
            }

            double normalized = (double)i / lengthSamples;
            double amplitude = track.Intensity.ValueAt(normalized) * MasterGain;

            // Raised-cosine edges avoid the clicks a hard cut-off would produce.
            int edge = Math.Min(i, lengthSamples - 1 - i);
            if (edge < rampSamples)
            {
                amplitude *= 0.5 - (0.5 * Math.Cos(Math.PI * edge / rampSamples));
            }

            phase += phaseStep;
            if (phase > 2 * Math.PI)
            {
                phase -= 2 * Math.PI;
            }

            buffer[index] += (float)(Math.Sin(phase) * amplitude);
        }
    }

    private static void RenderTransient(float[] buffer, HapticTrack track)
    {
        double peak = track.Intensity.Peak;
        if (peak <= 0)
        {
            return;
        }

        // Sharpness controls how quickly the hit decays: sharp = crisp click,
        // dull = soft thud.  This is the audible equivalent of the CoreHaptics
        // "sharpness" parameter.
        double sharpness = Math.Clamp(track.Sharpness.Peak, 0, 1);
        double tauMs = 6 + (24 * (1 - sharpness));
        int lengthSamples = Math.Min(
            (int)Math.Round(TransientMaxMs / 1000.0 * SampleRate),
            Math.Max(1, (int)Math.Round(track.DurationMs / 1000.0 * SampleRate)));

        int startSample = (int)Math.Round(track.StartMs / 1000.0 * SampleRate);
        double phaseStep = 2 * Math.PI * Math.Max(1.0, track.CarrierHz) / SampleRate;
        double phase = 0;
        int attackSamples = Math.Max(1, (int)(0.001 * SampleRate));

        for (int i = 0; i < lengthSamples; i++)
        {
            int index = startSample + i;
            if (index < 0 || index >= buffer.Length)
            {
                continue;
            }

            double tMs = i * 1000.0 / SampleRate;
            double envelope = Math.Exp(-tMs / tauMs);
            if (i < attackSamples)
            {
                envelope *= (double)i / attackSamples;
            }

            phase += phaseStep;
            if (phase > 2 * Math.PI)
            {
                phase -= 2 * Math.PI;
            }

            buffer[index] += (float)(Math.Sin(phase) * envelope * peak * MasterGain);
        }
    }
}
