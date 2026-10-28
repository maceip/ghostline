// Platform/SearchService.cs — the Windows answer to system search (contract §10).
//
// Windows offers two mechanisms:
//   1. "App Content Search" (Windows App SDK 2.5.1) — a limited-access
//      preview that REQUIRES package identity (MSIX) and an on-device index.
//      It is compiled in behind the ZODE_APP_CONTENT_SEARCH constant, which
//      is NOT defined by the default build: the API is not publicly available
//      yet, so referencing it would break the build.
//   2. A protocol handler: the MSIX manifest registers `zode://` and Windows
//      Search (or the user) can call zode://search?q=... which re-activates
//      the app and raises a "search" event for the web app (contract §2
//      onSearch).  This fallback works today, packaged or not.
//
// On top of that the shell keeps a small local index of everything that was
// attached to the app, so `search.query` always returns something useful.

using System.Text.Json.Nodes;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Platform;

internal sealed class SearchService
{
    private readonly List<SearchEntry> _index = new();
    private readonly object _sync = new();

    public void AddFile(string path, string name)
    {
        try
        {
            lock (_sync)
            {
                _index.RemoveAll(e => string.Equals(e.Path, path, StringComparison.OrdinalIgnoreCase));
                _index.Add(new SearchEntry
                {
                    Id = "file:" + path,
                    Title = name,
                    Subtitle = path,
                    Kind = "file",
                    Path = path,
                });

                if (_index.Count > 500)
                {
                    _index.RemoveRange(0, _index.Count - 500);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn("search", $"could not index '{path}': {ex.Message}");
        }
    }

    /// <summary>Resolves a query against the local index (contract §3 search.query).</summary>
    public JsonArray Query(string query)
    {
        var results = new JsonArray();
        try
        {
            List<SearchEntry> snapshot;
            lock (_sync)
            {
                snapshot = new List<SearchEntry>(_index);
            }

            foreach (SearchEntry entry in snapshot)
            {
                if (string.IsNullOrWhiteSpace(query) ||
                    entry.Title.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    entry.Subtitle.Contains(query, StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(entry.ToJson());
                }
            }
        }
        catch (Exception ex)
        {
            Log.Error("search", ex);
        }

#if ZODE_APP_CONTENT_SEARCH
        // MSIX-only path.  Enabled by defining ZODE_APP_CONTENT_SEARCH and
        // referencing the Windows App SDK 2.5.1 App Content Search package.
        // The package identity of the MSIX package is a hard requirement.
        try
        {
            results = Microsoft.Windows.ApplicationModel.Search.AppContentSearchIndex
                .QueryAsync(query).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Log.Warn("search", $"App Content Search is unavailable: {ex.Message}");
        }
#endif

        return results;
    }

    private sealed class SearchEntry
    {
        public required string Id { get; init; }

        public required string Title { get; init; }

        public required string Subtitle { get; init; }

        public required string Kind { get; init; }

        public string? Path { get; init; }

        public JsonObject ToJson() => new()
        {
            ["id"] = Id,
            ["title"] = Title,
            ["subtitle"] = Subtitle,
            ["kind"] = Kind,
            ["payload"] = new JsonObject
            {
                ["path"] = Path ?? string.Empty,
            },
        };
    }
}
