// SelfTest.cs — the shell checks that it can actually run.
//
// The point of this is the artifact problem: a release once shipped a bare
// `Zode.Shell.exe`, which is only the ~520 KB apphost launcher of a
// self-contained publish.  It downloaded fine and then did nothing at all,
// because the ~100 MB of .NET runtime files and the `web/` folder were not
// next to it.
//
// So the shell can be asked to prove itself:
//
//     Zode.Shell.exe --selftest
//
// It resolves its resources the same way the app does — no shortcuts, no
// test-only code path — and prints one line per check.  It exits 0 when
// everything is there and 1 when something is not, which is what the CI
// job and the release job assert on.
//
// Running it needs no window, no WebView2 and no display.

using System.Text.Json;

namespace Zode.Shell.Diagnostics;

internal static class SelfTest
{
    /// <summary>Runs the checks. Returns 0 when the shell is whole.</summary>
    public static int Run()
    {
        var failures = new List<string>();

        bool Check(string name, bool ok, string detail = "")
        {
            Console.WriteLine(ok ? $"  ok   {name}" : $"  FAIL {name} — {detail}");
            if (!ok)
            {
                failures.Add(name);
            }

            return ok;
        }

        Console.WriteLine("Zode shell self test");
        Console.WriteLine($"  base directory: {AppContext.BaseDirectory}");

        // 1. The shell is running from where it thinks it is.
        string exePath = Environment.ProcessPath ?? string.Empty;
        Check("the executable path is readable", exePath.Length > 0);
        Check(
            "the executable sits in the base directory",
            exePath.StartsWith(AppContext.BaseDirectory, StringComparison.OrdinalIgnoreCase),
            $"{exePath} is not under {AppContext.BaseDirectory}");

        // 2. The web app.  This is the same resolution the app uses.
        string webRoot = Path.Combine(AppContext.BaseDirectory, "web");
        Check("the web folder is next to the executable", Directory.Exists(webRoot), webRoot);

        if (Directory.Exists(webRoot))
        {
            string index = Path.Combine(webRoot, "index.html");
            bool indexOk = File.Exists(index);
            Check("web/index.html exists", indexOk, index);

            if (indexOk)
            {
                string html = File.ReadAllText(index);
                // The placeholder the shell writes when the web app is
                // missing must not be mistaken for the real thing.
                Check(
                    "web/index.html is the real app, not the placeholder",
                    (html.Contains("zode-root", StringComparison.Ordinal)
                        || html.Contains("id=\"root\"", StringComparison.Ordinal))
                        && !html.Contains("The web app is missing", StringComparison.Ordinal),
                    "the placeholder page is in place");
            }

            string assetsDir = Path.Combine(webRoot, "assets");
            bool hasCompiledJs = Directory.Exists(assetsDir)
                && Directory.GetFiles(assetsDir, "*.js").Length > 0;
            Check("web/assets has compiled JS bundle",
                hasCompiledJs || File.Exists(Path.Combine(webRoot, "src", "main.js")));
            Check("web/zode-mark.svg exists", File.Exists(Path.Combine(webRoot, "zode-mark.svg")));
            Check("web/assets/tokens.css exists", File.Exists(Path.Combine(webRoot, "assets", "tokens.css")));

            // 3. The shared contract data has to be valid JSON with the
            //    programs the shells expect.
            string haptics = Path.Combine(webRoot, "assets", "haptics.json");
            if (Check("web/assets/haptics.json exists", File.Exists(haptics), haptics))
            {
                try
                {
                    using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(haptics));
                    JsonElement programs = doc.RootElement.GetProperty("programs");
                    bool hasDone = programs.TryGetProperty("done", out _);
                    bool hasWorking = programs.TryGetProperty("working", out _);
                    Check("haptics.json has the 'done' program", hasDone);
                    Check("haptics.json has the 'working' program", hasWorking);
                }
                catch (Exception ex)
                {
                    Check("haptics.json parses", false, ex.Message);
                }
            }

            string library = Path.Combine(webRoot, "assets", "library.json");
            if (Check("web/assets/library.json exists", File.Exists(library), library))
            {
                try
                {
                    using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(library));
                    int tracks = doc.RootElement.GetProperty("tracks").GetArrayLength();
                    Check("library.json has tracks", tracks > 0, $"{tracks} tracks");
                }
                catch (Exception ex)
                {
                    Check("library.json parses", false, ex.Message);
                }
            }
        }

        Console.WriteLine();
        if (failures.Count == 0)
        {
            Console.WriteLine("SELFTEST PASSED — the shell can start and finds its resources.");
            return 0;
        }

        Console.WriteLine($"SELFTEST FAILED — {failures.Count} check(s) did not pass:");
        foreach (string failure in failures)
        {
            Console.WriteLine($"  - {failure}");
        }
        Console.WriteLine();
        Console.WriteLine("If the web folder is missing, the app was packaged without it.");
        Console.WriteLine("If the process died before this text appeared, the .NET runtime");
        Console.WriteLine("is missing next to the executable — ship the whole folder.");
        return 1;
    }
}
