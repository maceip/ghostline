// Attachments/DataObjectReader.cs — reads the file list out of a CF_HDROP
// data object (contract §8).
//
// The FORMATETC / STGMEDIUM structures are written byte by byte instead of
// being marshalled by the runtime: the native layout then cannot drift and we
// do not depend on the exact layout of the System.Runtime.InteropServices
// .ComTypes helper structs.

using System.Runtime.InteropServices;
using Zode.Shell.Interop;
using Zode.Shell.Native;

namespace Zode.Shell.Attachments;

internal static class DataObjectReader
{
    private const int CF_HDROP = 15;
    private const int DVASPECT_CONTENT = -1;
    private const int TYMED_HGLOBAL = 2;
    private const int FORMATETC_SIZE = 32;

    /// <summary>Returns the file paths carried by a CF_HDROP data object.</summary>
    public static IReadOnlyList<string> GetFilePaths(object? dataObject)
    {
        IComDataObject? com = ComDataObject.TryWrap(dataObject);
        if (com is null)
        {
            return Array.Empty<string>();
        }

        IntPtr formatEtc = Marshal.AllocHGlobal(FORMATETC_SIZE);
        IntPtr medium = IntPtr.Zero;
        try
        {
            for (int i = 0; i < FORMATETC_SIZE; i++)
            {
                Marshal.WriteByte(formatEtc, i, 0);
            }

            Marshal.WriteInt16(formatEtc, 0, (short)CF_HDROP);   // cfFormat
            Marshal.WriteInt32(formatEtc, 4, DVASPECT_CONTENT);  // dwAspect
            Marshal.WriteInt32(formatEtc, 8, -1);                 // lindex
            Marshal.WriteInt32(formatEtc, 12, TYMED_HGLOBAL);     // tymed
            Marshal.WriteIntPtr(formatEtc, 16, IntPtr.Zero);      // pClsid

            int hr = com.GetData(formatEtc, out medium);
            if (hr != 0 || medium == IntPtr.Zero)
            {
                return Array.Empty<string>();
            }

            int tymed = Marshal.ReadInt32(medium, 0);
            if (tymed != TYMED_HGLOBAL)
            {
                return Array.Empty<string>();
            }

            int unionOffset = IntPtr.Size == 8 ? 8 : 4;
            IntPtr hDrop = Marshal.ReadIntPtr(medium, unionOffset);
            if (hDrop == IntPtr.Zero)
            {
                return Array.Empty<string>();
            }

            return ReadDroppedFiles(hDrop);
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
        finally
        {
            if (medium != IntPtr.Zero)
            {
                Ole32.ReleaseStgMedium(medium);
            }

            Marshal.FreeHGlobal(formatEtc);
        }
    }

    private static IReadOnlyList<string> ReadDroppedFiles(IntPtr hDrop)
    {
        uint count = Shell32.DragQueryFileW(hDrop, 0xFFFFFFFF, IntPtr.Zero, 0);
        if (count == 0 || count == 0xFFFFFFFF)
        {
            return Array.Empty<string>();
        }

        var files = new List<string>((int)count);
        for (uint i = 0; i < count; i++)
        {
            string? path = ReadDroppedFileName(hDrop, i);
            if (!string.IsNullOrEmpty(path))
            {
                files.Add(path);
            }
        }

        return files;
    }

    private static string? ReadDroppedFileName(IntPtr hDrop, uint index)
    {
        int capacity = 512;
        while (capacity <= 32768)
        {
            IntPtr buffer = Marshal.AllocHGlobal(capacity * sizeof(char));
            try
            {
                uint length = Shell32.DragQueryFileW(hDrop, index, buffer, (uint)capacity);
                if (length == 0)
                {
                    return null;
                }

                if (length < capacity)
                {
                    return Marshal.PtrToStringUni(buffer) ?? string.Empty;
                }

                // The name did not fit: grow the buffer and try again.
                capacity *= 2;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        return null;
    }
}

/// <summary>Wraps an arbitrary COM data object into our IDataObject declaration.</summary>
internal static class ComDataObject
{
    public static IComDataObject? TryWrap(object? dataObject)
    {
        if (dataObject is null)
        {
            return null;
        }

        if (dataObject is IComDataObject already)
        {
            return already;
        }

        IntPtr unknown = IntPtr.Zero;
        try
        {
            unknown = Marshal.GetIUnknownForObject(dataObject);
            Guid iid = ComIds.IID_IDataObject;
            int hr = Marshal.QueryInterface(unknown, ref iid, out IntPtr ppv);
            if (hr != 0 || ppv == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                return (IComDataObject)Marshal.GetObjectForIUnknown(ppv);
            }
            finally
            {
                Marshal.Release(ppv);
            }
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            if (unknown != IntPtr.Zero)
            {
                Marshal.Release(unknown);
            }
        }
    }
}
