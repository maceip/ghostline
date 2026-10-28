// Haptics/HapticLibrary.cs — loads packages/shared/haptics.json.
//
// The JSON is embedded into the assembly by the .csproj (and also copied next
// to the executable), so the shell never has to invent a waveform: contract §7
// requires the canonical programs to be the single source of truth.

using System.Reflection;
using System.Text.Json.Nodes;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Haptics;

internal sealed class HapticLibrary
{
    /// <summary>Logical name of the embedded haptics.json resource.</summary>
    public const string ResourceName = "Zode.Shell.haptics.json";

    private readonly Dictionary<string, HapticProgram> _programs = new(StringComparer.Ordinal);

    private HapticLibrary()
    {
    }

    public IReadOnlyCollection<HapticProgram> Programs => _programs.Values;

    public static HapticLibrary Load()
    {
        var library = new HapticLibrary();
        try
        {
            string json = ReadEmbeddedJson() ?? ReadFileJson() ?? string.Empty;
            if (json.Length == 0)
            {
                Log.Warn("haptics", "haptics.json could not be found; haptic programs are unavailable.");
                return library;
            }

            if (JsonNode.Parse(json) is not JsonObject root)
            {
                Log.Warn("haptics", "haptics.json is not a JSON object.");
                return library;
            }

            if (root["programs"] is not JsonObject programs)
            {
                Log.Warn("haptics", "haptics.json does not contain a 'programs' object.");
                return library;
            }

            foreach (KeyValuePair<string, JsonNode?> entry in programs)
            {
                if (entry.Value is null)
                {
                    continue;
                }

                library._programs[entry.Key] = HapticProgram.Parse(entry.Key, entry.Value);
            }

            Log.Info("haptics", $"loaded {library._programs.Count} haptic programs: {string.Join(", ", library._programs.Keys)}");
        }
        catch (Exception ex)
        {
            Log.Error("haptics", ex);
        }

        return library;
    }

    public HapticProgram? Get(string name) =>
        !string.IsNullOrEmpty(name) && _programs.TryGetValue(name, out HapticProgram? program) ? program : null;

    private static string? ReadEmbeddedJson()
    {
        Assembly assembly = typeof(HapticLibrary).Assembly;
        using Stream? stream = assembly.GetManifestResourceStream(ResourceName);
        if (stream is null)
        {
            return null;
        }

        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static string? ReadFileJson()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "haptics.json");
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }
}
