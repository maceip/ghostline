// Haptics/HapticService.cs — the contract §7 haptic API.
//
//   haptic.play(program, { loop })  -> schedules the program
//   haptic.stop(program)            -> stops a looping program ("working")
//
// The programs come from packages/shared/haptics.json (never hard coded).
// On Windows the waveform is rendered as audio, therefore the shell reports
// capabilities.haptics = false: there is no haptic engine on a desktop.

using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Haptics;

internal sealed class HapticService : IDisposable
{
    private readonly HapticLibrary _library;
    private readonly VibrationService _vibration = new();
    private readonly Dictionary<string, WaveOutPlayer> _players = new(StringComparer.Ordinal);
    private readonly object _sync = new();
    private bool _disposed;

    public HapticService(HapticLibrary library)
    {
        _library = library;
        _vibration.EnsureInitialized();
    }

    public IReadOnlyCollection<HapticProgram> Programs => _library.Programs;

    /// <summary>Windows desktops have no haptic engine (contract §7).</summary>
    public bool HasHapticEngine => false;

    public void Play(string programName, bool loop)
    {
        HapticProgram program = _library.Get(programName)
            ?? throw new BridgeException(ErrorCodes.NotFound, $"Unknown haptic program '{programName}'.");

        bool shouldLoop = loop || program.Loop;
        float[] samples = WaveformSynthesizer.Synthesize(program);

        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            if (!_players.TryGetValue(programName, out WaveOutPlayer? player))
            {
                player = new WaveOutPlayer();
                _players[programName] = player;
            }

            if (!player.Play(samples, shouldLoop))
            {
                Log.Warn("haptics", $"could not play '{programName}' (no audio device?).");
            }
        }

        // Secondary path: a coarse vibration pulse matching the peak intensity.
        _vibration.Pulse(program.PeakIntensity, program.DurationMs);
    }

    public void Stop(string programName)
    {
        lock (_sync)
        {
            if (_players.TryGetValue(programName, out WaveOutPlayer? player))
            {
                player.Stop();
            }
        }
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
            foreach (WaveOutPlayer player in _players.Values)
            {
                player.Dispose();
            }

            _players.Clear();
        }
    }
}
