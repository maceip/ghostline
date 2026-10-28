// Native/Shell32.cs — shell32.dll entry points (AUMID, drag/drop, recent docs).

using System.Runtime.InteropServices;

namespace Zode.Shell.Native;

internal static class Shell32
{
    /// <summary>
    /// Assigns an explicit Application User Model ID to the current process.
    /// Required for unpackaged apps to show toast notifications and to own a
    /// Jump List (contract §9).
    /// </summary>
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SetCurrentProcessExplicitAppUserModelID(string? appID);

    /// <summary>CF_HDROP clipboard format.</summary>
    public const uint CF_HDROP = 15;

    /// <summary>Returns the number of files in a CF_HDROP handle (or 0xFFFFFFFF on error).</summary>
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint DragQueryFileW(IntPtr hDrop, uint iFile, IntPtr lpszFile, uint cch);

    /// <summary>Releases the memory associated with a drop operation.</summary>
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern void DragFinish(IntPtr hDrop);

    /// <summary>Adds a document to the "Recent Documents" list (feeds the app's Jump List).</summary>
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern void SHAddToRecentDocs(string? pszPath);
}
