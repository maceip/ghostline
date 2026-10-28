// Diagnostics/Log.cs — tiny file logger (no external packages).

using System.Diagnostics;
using System.Text;

namespace Zode.Shell.Diagnostics;

internal static class Log
{
    private static readonly object Gate = new();
    private static string? _logFile;

    public static string LogFilePath
    {
        get
        {
            if (_logFile is null)
            {
                string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string dir = Path.Combine(root, "Zode", "logs");
                Directory.CreateDirectory(dir);
                _logFile = Path.Combine(dir, "zode-shell.log");
            }

            return _logFile;
        }
    }

    public static void Info(string area, string message) => Write("INFO ", area, message, null);

    public static void Warn(string area, string message) => Write("WARN ", area, message, null);

    public static void Error(string area, string message) => Write("ERROR", area, message, null);

    public static void Error(string area, Exception ex) =>
        Write("ERROR", area, ex.Message, ex);

    private static void Write(string level, string area, string message, Exception? ex)
    {
        string line = $"{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss.fff}Z {level} [{area}] {message}";
        Debug.WriteLine(line);
        if (ex is not null)
        {
            Debug.WriteLine(ex.ToString());
        }

        try
        {
            lock (Gate)
            {
                File.AppendAllText(LogFilePath, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // Logging must never take the shell down.
        }
    }
}
