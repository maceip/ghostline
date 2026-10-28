// Native/WinMm.cs — winmm.dll "waveOut" entry points.
//
// The Windows desktop has no rich haptic engine (contract §7), so the shell
// synthesises the canonical waveforms from packages/shared/haptics.json and
// plays them as audio through the classic waveOut API.  No third-party
// packages are involved: everything below is a P/Invoke.

using System.Runtime.InteropServices;

namespace Zode.Shell.Native;

internal static class WinMm
{
    // ---- waveOut ---------------------------------------------------------
    public const int WAVE_FORMAT_PCM = 1;
    public const int WAVE_FORMAT_IEEE_FLOAT = 3;

    public const uint CALLBACK_NULL = 0x00000000;
    public const uint CALLBACK_EVENT = 0x00050000;

    public const uint WHDR_DONE = 0x00000001;
    public const uint WHDR_LOOP = 0x00000008;

    public const int MMSYSERR_NOERROR = 0;
    public const int WAVERR_STILLPLAYING = 33;
    public const int WAVERR_UNPREPARED = 11;

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern uint waveOutGetNumDevs();

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern int waveOutOpen(out IntPtr phwo, IntPtr pwfx, IntPtr pdwCallback,
        IntPtr dwInstance, uint fdwOpen);

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern int waveOutClose(IntPtr hwo);

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern int waveOutPrepareHeader(IntPtr hwo, IntPtr lpWaveOutHdr, int uSize);

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern int waveOutUnprepareHeader(IntPtr hwo, IntPtr lpWaveOutHdr, int uSize);

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern int waveOutWrite(IntPtr hwo, IntPtr lpWaveOutHdr, int uSize);

    [DllImport("winmm.dll", ExactSpelling = true)]
    public static extern int waveOutReset(IntPtr hwo);

    // ---- WAVEFORMATEX (18 bytes, written by hand for a stable layout) ----
    public const int WAVEFORMATEX_SIZE = 20;

    public static IntPtr AllocateWaveFormatEx(ushort formatTag, ushort channels, uint sampleRate,
        ushort bitsPerSample)
    {
        IntPtr block = Marshal.AllocHGlobal(WAVEFORMATEX_SIZE);
        for (int i = 0; i < WAVEFORMATEX_SIZE; i++)
        {
            Marshal.WriteByte(block, i, 0);
        }

        ushort blockAlign = (ushort)(channels * (bitsPerSample / 8));
        uint avgBytes = sampleRate * blockAlign;

        Marshal.WriteInt16(block, 0, (short)formatTag);      // wFormatTag
        Marshal.WriteInt16(block, 2, (short)channels);       // nChannels
        Marshal.WriteInt32(block, 4, unchecked((int)sampleRate));  // nSamplesPerSec
        Marshal.WriteInt32(block, 8, unchecked((int)avgBytes));     // nAvgBytesPerSec
        Marshal.WriteInt16(block, 12, (short)blockAlign);   // nBlockAlign
        Marshal.WriteInt16(block, 14, (short)bitsPerSample);// wBitsPerSample
        Marshal.WriteInt16(block, 16, 0);                   // cbSize
        return block;
    }

    // ---- WAVEHDR ---------------------------------------------------------
    // Offsets differ between x86 and x64 because of the pointer fields.
    public static int HeaderSize => IntPtr.Size == 8 ? 48 : 32;

    public static int HeaderOffsetData => 0;
    public static int HeaderOffsetBufferLength => IntPtr.Size == 8 ? 8 : 4;
    public static int HeaderOffsetBytesRecorded => IntPtr.Size == 8 ? 12 : 8;
    public static int HeaderOffsetUser => IntPtr.Size == 8 ? 16 : 12;
    public static int HeaderOffsetFlags => IntPtr.Size == 8 ? 24 : 16;
    public static int HeaderOffsetLoops => IntPtr.Size == 8 ? 28 : 20;
    public static int HeaderOffsetNext => IntPtr.Size == 8 ? 32 : 24;
    public static int HeaderOffsetReserved => IntPtr.Size == 8 ? 40 : 28;

    public static IntPtr AllocateHeader()
    {
        IntPtr block = Marshal.AllocHGlobal(HeaderSize);
        for (int i = 0; i < HeaderSize; i++)
        {
            Marshal.WriteByte(block, i, 0);
        }

        return block;
    }
}
