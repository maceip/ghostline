// Platform/SystemInfo.cs — the payload of the `app.info` request (contract §3).

using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace Zode.Shell.Platform;

internal static class SystemInfo
{
    public static JsonObject Describe()
    {
        Assembly assembly = typeof(SystemInfo).Assembly;

        string version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "1.0.0";

        string build = assembly.GetName().Version?.ToString() ?? "0.0.0.0";

        return new JsonObject
        {
            ["version"] = version,
            ["build"] = build,
            ["platform"] = "windows",
            ["deviceModel"] = DeviceModel(),
        };
    }

    private static string DeviceModel()
    {
        string cpu = string.Empty;
        try
        {
            using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
            cpu = key?.GetValue("ProcessorNameString") as string ?? string.Empty;
        }
        catch (Exception)
        {
            cpu = string.Empty;
        }

        cpu = cpu.Trim();
        string model = cpu.Length == 0 ? "Windows PC" : cpu;
        return $"{model} ({Environment.OSVersion.VersionString})";
    }
}
