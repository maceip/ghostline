using System;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

/// <summary>
/// A syntax-only checker for the C# sources of the Windows shell.
///
/// Roslyn parses each file and reports the parse diagnostics.  No reference
/// is resolved, so the Win32 and WebView2 types never have to exist and the
/// check runs on any machine with the .NET SDK — not just on Windows.
///
/// This is not a type check.  The full compile happens in
/// .github/workflows/ci.yml on the windows runner, where `dotnet build`
/// resolves every reference against the real Windows SDK.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        var errors = 0;
        var files = 0;
        var options = new CSharpParseOptions(LanguageVersion.Latest);

        foreach (var file in args.OrderBy(a => a, StringComparer.Ordinal))
        {
            if (!file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            files++;
            var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file), options, file);

            foreach (var diagnostic in tree.GetDiagnostics()
                         .Where(d => d.Severity == DiagnosticSeverity.Error))
            {
                var position = diagnostic.Location.GetLineSpan().StartLinePosition;
                Console.WriteLine(
                    $"{file}({position.Line + 1},{position.Character + 1}): " +
                    $"{diagnostic.Id}: {diagnostic.GetMessage()}");
                errors++;
            }
        }

        Console.WriteLine($"  parsed {files} C# file(s), {errors} syntax error(s)");
        return errors == 0 ? 0 : 1;
    }
}
