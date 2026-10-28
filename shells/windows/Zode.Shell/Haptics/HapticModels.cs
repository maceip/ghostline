// Haptics/HapticModels.cs — the model of packages/shared/haptics.json.
//
// The programs are defined ONCE in the shared package (contract §7); the
// shell only parses and renders them.  No waveform is hard coded in C#.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zode.Shell.Haptics;

/// <summary>A normalised intensity / sharpness curve (contract §7 semantics).</summary>
internal sealed class HapticCurve
{
    private readonly (double Time, double Value)[] _points;

    private HapticCurve((double Time, double Value)[] points) => _points = points;

    public static HapticCurve Constant(double value) => new(new[] { (0.0, value), (1.0, value) });

    public static HapticCurve FromPoints(IEnumerable<(double Time, double Value)> points)
    {
        var ordered = points.OrderBy(p => p.Time).ToArray();
        return ordered.Length == 0 ? Constant(0) : new HapticCurve(ordered);
    }

    /// <summary>Highest value of the curve.</summary>
    public double Peak => _points.Length == 0 ? 0 : _points.Max(p => p.Value);

    /// <summary>
    /// Linear interpolation between the control points, exactly like the
    /// WebAudio renderer of the web fallback shim (contract §6/§7).
    /// </summary>
    public double ValueAt(double normalizedTime)
    {
        if (_points.Length == 0)
        {
            return 0;
        }

        if (normalizedTime <= _points[0].Time)
        {
            return _points[0].Value;
        }

        for (int i = 1; i < _points.Length; i++)
        {
            (double t0, double v0) = _points[i - 1];
            (double t1, double v1) = _points[i];
            if (normalizedTime <= t1)
            {
                double span = t1 - t0;
                if (span <= 0)
                {
                    return v1;
                }

                double ratio = (normalizedTime - t0) / span;
                return v0 + ((v1 - v0) * ratio);
            }
        }

        return _points[^1].Value;
    }

    public static HapticCurve Parse(JsonNode? node)
    {
        if (node is null)
        {
            return Constant(0);
        }

        if (node is JsonArray array)
        {
            var points = new List<(double, double)>();
            foreach (JsonNode? entry in array)
            {
                if (entry is not JsonArray pair || pair.Count < 2)
                {
                    continue;
                }

                if (TryGetDouble(pair[0], out double time) && TryGetDouble(pair[1], out double value))
                {
                    points.Add((time, value));
                }
            }

            return FromPoints(points);
        }

        return Constant(TryGetDouble(node, out double constant) ? constant : 0);
    }

    private static bool TryGetDouble(JsonNode? node, out double value)
    {
        value = 0;
        if (node is null)
        {
            return false;
        }

        try
        {
            value = node.GetValueKind() switch
            {
                JsonValueKind.Number => node.GetValue<double>(),
                JsonValueKind.String => double.TryParse(node.GetValue<string>(), out double parsed) ? parsed : 0,
                _ => 0,
            };
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}

/// <summary>One track of a haptic program.</summary>
internal sealed class HapticTrack
{
    public string Kind { get; init; } = "continuous";

    public int StartMs { get; init; }

    public int DurationMs { get; init; }

    public double CarrierHz { get; init; } = 220;

    public HapticCurve Intensity { get; init; } = HapticCurve.Constant(0);

    public HapticCurve Sharpness { get; init; } = HapticCurve.Constant(0);

    public bool IsTransient => string.Equals(Kind, "transient", StringComparison.OrdinalIgnoreCase);
}

/// <summary>A named haptic program ("done", "working", ...).</summary>
internal sealed class HapticProgram
{
    public string Name { get; init; } = string.Empty;

    public string Label { get; init; } = string.Empty;

    public string Description { get; init; } = string.Empty;

    public int DurationMs { get; init; }

    public bool Loop { get; init; }

    public IReadOnlyList<HapticTrack> Tracks { get; init; } = Array.Empty<HapticTrack>();

    public double PeakIntensity => Tracks.Count == 0 ? 0 : Tracks.Max(t => t.Intensity.Peak);

    public static HapticProgram Parse(string name, JsonNode node)
    {
        int durationMs = ReadInt(node["durationMs"], 0);
        bool loop = ReadBool(node["loop"], false);
        string label = ReadString(node["label"]) ?? name;
        string description = ReadString(node["description"]) ?? string.Empty;

        var tracks = new List<HapticTrack>();
        if (node["tracks"] is JsonArray trackArray)
        {
            foreach (JsonNode? trackNode in trackArray)
            {
                if (trackNode is null)
                {
                    continue;
                }

                tracks.Add(new HapticTrack
                {
                    Kind = ReadString(trackNode["kind"]) ?? "continuous",
                    StartMs = ReadInt(trackNode["startMs"], 0),
                    DurationMs = ReadInt(trackNode["durationMs"], durationMs),
                    CarrierHz = ReadDouble(trackNode["carrierHz"], 220),
                    Intensity = HapticCurve.Parse(trackNode["intensity"]),
                    Sharpness = HapticCurve.Parse(trackNode["sharpness"]),
                });
            }
        }

        return new HapticProgram
        {
            Name = name,
            Label = label,
            Description = description,
            DurationMs = durationMs,
            Loop = loop,
            Tracks = tracks,
        };
    }

    private static string? ReadString(JsonNode? node)
    {
        if (node is null)
        {
            return null;
        }

        try
        {
            return node.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : node.ToJsonString();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int ReadInt(JsonNode? node, int fallback)
    {
        if (node is null)
        {
            return fallback;
        }

        try
        {
            return node.GetValueKind() == JsonValueKind.Number ? node.GetValue<int>() : fallback;
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    private static double ReadDouble(JsonNode? node, double fallback)
    {
        if (node is null)
        {
            return fallback;
        }

        try
        {
            return node.GetValueKind() == JsonValueKind.Number ? node.GetValue<double>() : fallback;
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    private static bool ReadBool(JsonNode? node, bool fallback)
    {
        if (node is null)
        {
            return fallback;
        }

        try
        {
            return node.GetValueKind() switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback,
            };
        }
        catch (Exception)
        {
            return fallback;
        }
    }
}
