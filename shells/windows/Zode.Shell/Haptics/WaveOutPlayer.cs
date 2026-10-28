// Haptics/WaveOutPlayer.cs — plays a synthesised PCM buffer through winmm.
//
// Self-contained: only the waveOut* functions of winmm.dll are used, so the
// shell keeps its "one NuGet package only" rule (Microsoft.Web.WebView2).

using System.Runtime.InteropServices;
using Zode.Shell.Diagnostics;
using Zode.Shell.Native;

namespace Zode.Shell.Haptics;

internal sealed class WaveOutPlayer : IDisposable
{
    private const int BitsPerSample = 16;
    private const ushort Channels = 1;

    private readonly object _sync = new();
    private IntPtr _waveOut;
    private IntPtr _header;
    private IntPtr _audio;
    private IntPtr _format;
    private AutoResetEvent? _done;
    private Thread? _pump;
    private bool _loop;
    private volatile bool _stopping;
    private bool _disposed;

    /// <summary>True when the audio device accepted the buffer.</summary>
    public bool IsPlaying { get; private set; }

    /// <summary>
    /// Plays a mono PCM buffer.  When <paramref name="loop"/> is true the
    /// buffer repeats until <see cref="Stop"/> is called (contract §7: the
    /// "working" program must loop until it is stopped).
    /// </summary>
    public bool Play(float[] samples, bool loop)
    {
        if (samples.Length == 0)
        {
            return false;
        }

        lock (_sync)
        {
            if (_disposed)
            {
                return false;
            }

            StopCore();

            if (WinMm.waveOutGetNumDevs() == 0)
            {
                Log.Warn("haptics", "no audio output device is available; the haptic waveform stays silent.");
                return false;
            }

            byte[] pcm = ToPcm16(samples);

            _format = WinMm.AllocateWaveFormatEx(WinMm.WAVE_FORMAT_PCM, Channels,
                WaveformSynthesizer.SampleRate, BitsPerSample);

            int hr = WinMm.waveOutOpen(out IntPtr waveOut, _format, IntPtr.Zero, IntPtr.Zero,
                WinMm.CALLBACK_EVENT);
            if (hr != WinMm.MMSYSERR_NOERROR || waveOut == IntPtr.Zero)
            {
                Log.Warn("haptics", $"waveOutOpen failed (mm error {hr}); the haptic waveform stays silent.");
                ReleaseFormat();
                return false;
            }

            _waveOut = waveOut;
            _audio = Marshal.AllocHGlobal(pcm.Length);
            Marshal.Copy(pcm, 0, _audio, pcm.Length);

            _header = WinMm.AllocateHeader();
            Marshal.WriteIntPtr(_header, WinMm.HeaderOffsetData, _audio);
            Marshal.WriteInt32(_header, WinMm.HeaderOffsetBufferLength, pcm.Length);
            Marshal.WriteInt32(_header, WinMm.HeaderOffsetBytesRecorded, pcm.Length);
            Marshal.WriteInt32(_header, WinMm.HeaderOffsetFlags, 0);
            Marshal.WriteInt32(_header, WinMm.HeaderOffsetLoops, 0);
            Marshal.WriteInt32(_header, WinMm.HeaderOffsetReserved, 0);

            _done = new AutoResetEvent(false);
            _stopping = false;
            _loop = loop;

            int prepare = WinMm.waveOutPrepareHeader(_waveOut, _header, WinMm.HeaderSize);
            if (prepare != WinMm.MMSYSERR_NOERROR)
            {
                Log.Warn("haptics", $"waveOutPrepareHeader failed (mm error {prepare}).");
                Cleanup();
                return false;
            }

            SetFlags(loop ? WinMm.WHDR_LOOP : 0);

            int write = WinMm.waveOutWrite(_waveOut, _header, WinMm.HeaderSize);
            if (write != WinMm.MMSYSERR_NOERROR)
            {
                Log.Warn("haptics", $"waveOutWrite failed (mm error {write}).");
                Cleanup();
                return false;
            }

            _pump = new Thread(Pump)
            {
                IsBackground = true,
                Name = "zode-waveout-pump",
            };
            _pump.Start();

            IsPlaying = true;
            return true;
        }
    }

    public void Stop()
    {
        lock (_sync)
        {
            StopCore();
        }
    }

    private void StopCore()
    {
        if (_waveOut == IntPtr.Zero)
        {
            return;
        }

        _stopping = true;
        IsPlaying = false;

        // Clear WHDR_LOOP so the driver stops repeating the buffer ...
        uint flags = unchecked((uint)Marshal.ReadInt32(_header, WinMm.HeaderOffsetFlags));
        Marshal.WriteInt32(_header, WinMm.HeaderOffsetFlags,
            unchecked((int)(flags & ~WinMm.WHDR_LOOP)));

        // ... and reset the device, which marks the header as done.
        WinMm.waveOutReset(_waveOut);
        WinMm.waveOutUnprepareHeader(_waveOut, _header, WinMm.HeaderSize);

        _done?.Set();
    }

    private void Pump()
    {
        while (!_stopping)
        {
            AutoResetEvent? done = _done;
            if (done is null)
            {
                break;
            }

            if (!done.WaitOne(200))
            {
                continue;
            }

            lock (_sync)
            {
                if (_stopping || _waveOut == IntPtr.Zero)
                {
                    break;
                }

                int flags = Marshal.ReadInt32(_header, WinMm.HeaderOffsetFlags);
                if ((flags & WinMm.WHDR_DONE) == 0)
                {
                    continue;
                }

                if (!_loop)
                {
                    WinMm.waveOutUnprepareHeader(_waveOut, _header, WinMm.HeaderSize);
                    IsPlaying = false;
                    break;
                }

                // The driver finished the buffer although WHDR_LOOP was set:
                // restart it so the program keeps looping (contract §7).
                SetFlags(WinMm.WHDR_LOOP);
                int hr = WinMm.waveOutWrite(_waveOut, _header, WinMm.HeaderSize);
                if (hr != WinMm.MMSYSERR_NOERROR)
                {
                    Log.Warn("haptics", $"waveOutWrite (loop restart) failed (mm error {hr}).");
                    IsPlaying = false;
                    break;
                }
            }
        }
    }

    // The WAVEHDR flags are a DWORD, so they are handled as uint all the way
    // through: mixing an int and a uint here is what the compiler rejects.
    private void SetFlags(uint flags) =>
        Marshal.WriteInt32(_header, WinMm.HeaderOffsetFlags, unchecked((int)flags));

    private void Cleanup()
    {
        if (_waveOut != IntPtr.Zero)
        {
            WinMm.waveOutReset(_waveOut);
            WinMm.waveOutClose(_waveOut);
            _waveOut = IntPtr.Zero;
        }

        if (_header != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_header);
            _header = IntPtr.Zero;
        }

        if (_audio != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_audio);
            _audio = IntPtr.Zero;
        }

        ReleaseFormat();
    }

    private void ReleaseFormat()
    {
        if (_format != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_format);
            _format = IntPtr.Zero;
        }
    }

    private static byte[] ToPcm16(float[] samples)
    {
        var bytes = new byte[samples.Length * 2];
        for (int i = 0; i < samples.Length; i++)
        {
            float clamped = Math.Clamp(samples[i], -1f, 1f);
            short value = (short)(clamped * short.MaxValue);
            bytes[i * 2] = (byte)(value & 0xFF);
            bytes[(i * 2) + 1] = (byte)((value >> 8) & 0xFF);
        }

        return bytes;
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            StopCore();
            Cleanup();
            _done?.Dispose();
            _done = null;
        }
    }
}
