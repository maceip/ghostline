// Interop/ComInterfaces.cs — the COM interfaces the shell needs.
//
// Everything is declared by hand so that the vtable order is explicit and
// reviewable; no third-party interop package is involved (the only NuGet
// dependency of this shell is Microsoft.Web.WebView2).
//
// Where a structure would have to be marshalled by the runtime we use IntPtr
// and write the bytes by hand instead: that keeps the native layout under
// our control and removes any dependency on the exact layout of the
// System.Runtime.InteropServices.ComTypes helper structs.

using System.Runtime.InteropServices;

namespace Zode.Shell.Interop;

/// <summary>Native IDataObject (IID_IDataObject).</summary>
[ComImport]
[Guid("0000010e-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IComDataObject
{
    [PreserveSig]
    int GetData(IntPtr pFormatEtc, out IntPtr pStgMedium);

    [PreserveSig]
    int GetDataHere(IntPtr pFormatEtc, IntPtr pStgMedium);

    [PreserveSig]
    int QueryGetData(IntPtr pFormatEtc);

    [PreserveSig]
    int GetCanonicalFormatEtc(IntPtr pFormatEtc, IntPtr pFormatEtcOther);

    [PreserveSig]
    int SetData(IntPtr pFormatEtc, IntPtr pStgMedium, uint hRelease);

    [PreserveSig]
    int EnumFormatEtc(uint dwReserved, IntPtr ppenumFormatEtc);

    [PreserveSig]
    int DAdvise(IntPtr pFormatEtc, uint dwAdvise, IntPtr pAdvise);

    [PreserveSig]
    int DUnadvise(uint dwCookie);

    [PreserveSig]
    int EnumDAdvise(IntPtr ppenumAdvise);
}

/// <summary>Native IDropTarget (IID_IDropTarget).</summary>
[ComImport]
[Guid("00000122-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDropTarget
{
    [PreserveSig]
    int DragEnter(IComDataObject pDataObject, int keyState, POINTL pt, out int pdwEffect);

    [PreserveSig]
    int DragOver(int keyState, POINTL pt, out int pdwEffect);

    [PreserveSig]
    int DragLeave();

    [PreserveSig]
    int Drop(IComDataObject pDataObject, int keyState, POINTL pt, out int pdwEffect);
}

[StructLayout(LayoutKind.Sequential)]
public struct POINTL
{
    public int x;
    public int y;
}

/// <summary>Native IShellItem.</summary>
[ComImport]
[Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    [PreserveSig]
    int BindToHandler(IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [PreserveSig]
    int GetParent(out IShellItem? ppsi);

    [PreserveSig]
    int GetDisplayName(uint sigdnName, out IntPtr ppszName);

    [PreserveSig]
    int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);

    [PreserveSig]
    int Compare(IShellItem psi, uint hint, out int piOrder);
}

/// <summary>Native IShellItemArray.</summary>
[ComImport]
[Guid("b63ea76d-1f85-456f-a19c-48159efa858b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItemArray
{
    [PreserveSig]
    int BindToHandler(IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [PreserveSig]
    int GetPropertyStore(uint flags, ref Guid riid, out IntPtr ppv);

    [PreserveSig]
    int GetPropertyDescriptionList(ref Guid riid, out IntPtr ppv);

    [PreserveSig]
    int GetAttributes(uint sfAttribfMask, out uint psfAttribs);

    [PreserveSig]
    int GetCount(out uint pcItems);

    [PreserveSig]
    int GetItemAt(uint i, out IShellItem? ppsi);

    [PreserveSig]
    int EnumItems(out IntPtr ppenum);
}

/// <summary>Native IFileDialog (IID_IFileDialog).</summary>
[ComImport]
[Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDialog
{
    [PreserveSig]
    int Show(IntPtr parent);

    [PreserveSig]
    int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);

    [PreserveSig]
    int SetFileTypeIndex(uint iFileType);

    [PreserveSig]
    int GetFileTypeIndex(out uint piFileType);

    [PreserveSig]
    int Advise(IntPtr pfde, out uint pdwCookie);

    [PreserveSig]
    int Unadvise(uint dwCookie);

    [PreserveSig]
    int SetOptions(uint fos);

    [PreserveSig]
    int GetOptions(out uint pfos);

    [PreserveSig]
    int SetDefaultFolder(IShellItem psi);

    [PreserveSig]
    int SetFolder(IShellItem psi);

    [PreserveSig]
    int GetCurrentSelection(out IShellItem? ppsi);

    [PreserveSig]
    int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);

    [PreserveSig]
    int GetFileName(out IntPtr ppszName);

    [PreserveSig]
    int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);

    [PreserveSig]
    int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);

    [PreserveSig]
    int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);

    [PreserveSig]
    int GetResult(out IShellItem? psi);

    [PreserveSig]
    int AddPlace(IShellItem psi, int fdap);

    [PreserveSig]
    int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);

    [PreserveSig]
    int Close(int hr);

    [PreserveSig]
    int SetClientGuid(ref Guid guid);

    [PreserveSig]
    int ClearClientData();

    [PreserveSig]
    int SetFilter(IntPtr pFilter);
}

/// <summary>Native IFileOpenDialog (IID_IFileOpenDialog).</summary>
[ComImport]
[Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOpenDialog
{
    [PreserveSig]
    int Show(IntPtr parent);

    [PreserveSig]
    int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);

    [PreserveSig]
    int SetFileTypeIndex(uint iFileType);

    [PreserveSig]
    int GetFileTypeIndex(out uint piFileType);

    [PreserveSig]
    int Advise(IntPtr pfde, out uint pdwCookie);

    [PreserveSig]
    int Unadvise(uint dwCookie);

    [PreserveSig]
    int SetOptions(uint fos);

    [PreserveSig]
    int GetOptions(out uint pfos);

    [PreserveSig]
    int SetDefaultFolder(IShellItem psi);

    [PreserveSig]
    int SetFolder(IShellItem psi);

    [PreserveSig]
    int GetCurrentSelection(out IShellItem? ppsi);

    [PreserveSig]
    int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);

    [PreserveSig]
    int GetFileName(out IntPtr ppszName);

    [PreserveSig]
    int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);

    [PreserveSig]
    int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);

    [PreserveSig]
    int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);

    [PreserveSig]
    int GetResult(out IShellItem? psi);

    [PreserveSig]
    int AddPlace(IShellItem psi, int fdap);

    [PreserveSig]
    int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);

    [PreserveSig]
    int Close(int hr);

    [PreserveSig]
    int SetClientGuid(ref Guid guid);

    [PreserveSig]
    int ClearClientData();

    [PreserveSig]
    int SetFilter(IntPtr pFilter);

    [PreserveSig]
    int GetResults(out IShellItemArray? ppshv);

    [PreserveSig]
    int GetSelectedItems(out IShellItemArray? ppshv);
}

/// <summary>Native IShellLinkW.</summary>
[ComImport]
[Guid("000214f9-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellLinkW
{
    [PreserveSig]
    int GetPath(IntPtr pszFile, int cch, IntPtr pfd, int fFlags);

    [PreserveSig]
    int GetIDList(out IntPtr ppidl);

    [PreserveSig]
    int SetIDList(IntPtr pidl);

    [PreserveSig]
    int GetDescription(IntPtr pszName, int cch);

    [PreserveSig]
    int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);

    [PreserveSig]
    int GetWorkingDirectory(IntPtr pszDir, int cch);

    [PreserveSig]
    int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);

    [PreserveSig]
    int GetArguments(IntPtr pszArgs, int cch);

    [PreserveSig]
    int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);

    [PreserveSig]
    int GetHotkey(out short phk);

    [PreserveSig]
    int SetHotkey(short hk);

    [PreserveSig]
    int GetShowCmd(out int piShowCmd);

    [PreserveSig]
    int SetShowCmd(int iShowCmd);

    [PreserveSig]
    int GetIconLocation(IntPtr pszIconPath, int cch, out int piIcon);

    [PreserveSig]
    int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);

    [PreserveSig]
    int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);

    [PreserveSig]
    int Resolve(IntPtr hwnd, int flags);

    [PreserveSig]
    int SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

/// <summary>Native IPersistFile (IID_IPersistFile).</summary>
[ComImport]
[Guid("0000010b-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPersistFile
{
    [PreserveSig]
    int GetClassID(out Guid pClassID);

    [PreserveSig]
    int IsDirty();

    [PreserveSig]
    int Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);

    [PreserveSig]
    int Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int fRemember);

    [PreserveSig]
    int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);

    [PreserveSig]
    int GetCurFile(out IntPtr ppszFileName);
}

/// <summary>Native IPropertyStore (IID_IPropertyStore).</summary>
[ComImport]
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    [PreserveSig]
    int GetCount(out uint cProperties);

    [PreserveSig]
    int GetAt(uint iProperty, IntPtr pkey);

    [PreserveSig]
    int GetValue(IntPtr key, IntPtr pv);

    [PreserveSig]
    int SetValue(IntPtr key, IntPtr propvar);

    [PreserveSig]
    int Commit(uint dwFlags);
}

/// <summary>Native IObjectCollection (IID_IObjectCollection).</summary>
[ComImport]
[Guid("86ea52d7-2e64-4f1e-82dc-0b4a451f3b0a")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IObjectCollection
{
    [PreserveSig]
    int AddObject(IntPtr pObject);

    [PreserveSig]
    int AddObjects(IntPtr pObjects);

    [PreserveSig]
    int GetCount(out uint pCount);

    [PreserveSig]
    int GetObjectAt(uint iObject, out IntPtr ppObject);
}

/// <summary>Native ICustomDestinationList (IID_ICustomDestinationList).</summary>
[ComImport]
[Guid("5512c5bd-e12a-4c0a-882c-3e8f0d3b0f0a")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ICustomDestinationList
{
    [PreserveSig]
    int BeginList(out uint cTasks, out IntPtr pidlTaskList, out IntPtr ppvTaskList);

    [PreserveSig]
    int AppendList(IntPtr pidlTaskList, IntPtr pTaskList);

    [PreserveSig]
    int SetList(IntPtr pidlTaskList, IntPtr pTaskList);

    [PreserveSig]
    int SaveList();
}

/// <summary>Well known CLSIDs / IIDs used by the shell.</summary>
internal static class ComIds
{
    public static readonly Guid IID_IDropTarget = new("00000122-0000-0000-C000-000000000046");
    public static readonly Guid IID_IDataObject = new("0000010e-0000-0000-C000-000000000046");
    public static readonly Guid IID_IShellLinkW = new("000214f9-0000-0000-C000-000000000046");
    public static readonly Guid IID_IPersistFile = new("0000010b-0000-0000-C000-000000000046");
    public static readonly Guid IID_IPropertyStore = new("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    public static readonly Guid IID_IObjectCollection = new("86ea52d7-2e64-4f1e-82dc-0b4a451f3b0a");
    public static readonly Guid IID_ICustomDestinationList = new("5512c5bd-e12a-4c0a-882c-3e8f0d3b0f0a");

    public static readonly Guid CLSID_ShellLink = new("00021401-0000-0000-C000-000000000046");
    public static readonly Guid CLSID_FileOpenDialog = new("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7");
    public static readonly Guid CLSID_DestinationList = new("2e941141-7f97-4756-ba1d-9decde894a3d");
    public static readonly Guid CLSID_EnumerableObjectCollection = new("0002e005-0000-0000-c000-000000000046");

    /// <summary>System.AppUserModel.ID — the AppUserModelID of a shell link.</summary>
    public static readonly Guid PKEY_AppUserModelId = new("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3");
}
