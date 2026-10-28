// Haptics/VibrationService.cs — the coarse, secondary haptic path.
//
// Windows desktops expose no rich haptic engine; the only thing available is
// the vibration device, which can only produce a coarse pulse (contract §7).
// We still fire it, mapped to the peak intensity of the program, so that
// devices which do have a rumble motor (some tablets, Surface devices) react
// to the same programs as the synthesised audio waveform.
//
// Only the *public* Windows.Devices.Haptics API is used: the
// `VibrationDevice` class and its `SimpleHapticsController`.  The
// `IVibrationDevice` / `IVibrationSimpleHapticsController` interfaces and
// the `HapticFeedback` struct are internal to the platform and cannot be
// referenced from an app.
//
// The waveform itself is not constructed either: `SimpleHapticsControllerFeedback`
// has no public constructor, because a device only plays the waveforms it
// says it supports.  The waveform is therefore picked out of the controller's
// own `SupportedFeedback` list.

using Windows.Devices.Haptics;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Haptics;

internal sealed class VibrationService
{
    private VibrationDevice? _device;
    private SimpleHapticsController? _controller;
    private bool _initialized;

    public bool IsAvailable => _controller is not null;

    /// <summary>Kicks off the (asynchronous) device lookup exactly once.</summary>
    public void EnsureInitialized()
    {
        if (_initialized)
        {
            return;
        }

        _initialized = true;
        _ = InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            // The platform asks for permission before a device may be used.
            VibrationAccessStatus access = await VibrationDevice.RequestAccessAsync();
            if (access != VibrationAccessStatus.Allowed)
            {
                Log.Info("haptics", $"vibration access was not granted ({access}); expected on desktops");
                return;
            }

            _device = await VibrationDevice.GetDefaultAsync();
            _controller = _device?.SimpleHapticsController;

            Log.Info("haptics", _controller is null
                ? "no vibration device available (expected on desktops)"
                : "vibration device available; coarse pulses are enabled");
        }
        catch (Exception ex)
        {
            Log.Warn("haptics", $"vibration device lookup failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Fires a coarse pulse that matches the peak intensity of the program.
    /// Silently does nothing when no vibration device exists.
    /// </summary>
    public void Pulse(double peakIntensity, int durationMs)
    {
        SimpleHapticsController? controller = _controller;
        if (controller is null)
        {
            return;
        }

        try
        {
            double intensity = Math.Clamp(peakIntensity, 0, 1);
            TimeSpan duration = TimeSpan.FromMilliseconds(Math.Clamp(durationMs, 10, 2000));

            // A device only plays the waveforms it says it supports, so the
            // waveform is picked out of that list rather than constructed.
            foreach (var waveform in controller.SupportedFeedback)
            {
                if (waveform.Waveform != KnownSimpleHapticsControllerWaveforms.Click)
                {
                    continue;
                }

                Send(controller, waveform, intensity, duration);
                return;
            }

            // No click waveform: any supported waveform is better than none.
            foreach (var waveform in controller.SupportedFeedback)
            {
                Send(controller, waveform, intensity, duration);
                return;
            }
        }
        catch (Exception ex)
        {
            Log.Warn("haptics", $"vibration pulse failed: {ex.Message}");
        }
    }

    private static void Send(
        SimpleHapticsController controller,
        SimpleHapticsControllerFeedback waveform,
        double intensity,
        TimeSpan duration)
    {
        if (controller.IsPlayDurationSupported)
        {
            controller.SendHapticFeedbackForDuration(waveform, intensity, duration);
        }
        else
        {
            controller.SendHapticFeedback(waveform, intensity);
        }
    }

    /// <summary>Stops a pulse that is still running.</summary>
    public void Stop()
    {
        try
        {
            _controller?.StopFeedback();
        }
        catch (Exception ex)
        {
            Log.Warn("haptics", $"stopping the vibration failed: {ex.Message}");
        }
    }
}
