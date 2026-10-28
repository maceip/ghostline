// Attachments/AttachmentFactory.cs — builds Attachment objects from file paths.

namespace Zode.Shell.Attachments;

internal static class AttachmentFactory
{
    private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".svg"] = "image/svg+xml",
        [".bmp"] = "image/bmp",
        [".ico"] = "image/x-icon",
        [".mp3"] = "audio/mpeg",
        [".m4a"] = "audio/mp4",
        [".wav"] = "audio/wav",
        [".flac"] = "audio/flac",
        [".ogg"] = "audio/ogg",
        [".mp4"] = "video/mp4",
        [".webm"] = "video/webm",
        [".mkv"] = "video/x-matroska",
        [".pdf"] = "application/pdf",
        [".txt"] = "text/plain",
        [".md"] = "text/markdown",
        [".json"] = "application/json",
        [".xml"] = "application/xml",
        [".zip"] = "application/zip",
        [".css"] = "text/css",
        [".js"] = "text/javascript",
        [".html"] = "text/html",
    };

    public static Attachment FromPath(string path, string source)
    {
        string fullPath = path;
        long size = 0;
        try
        {
            if (File.Exists(fullPath))
            {
                size = new FileInfo(fullPath).Length;
            }
        }
        catch (Exception)
        {
            size = 0;
        }

        return new Attachment
        {
            Id = AttachmentIds.Next(),
            Name = Path.GetFileName(fullPath),
            Path = fullPath,
            MimeType = GuessMimeType(fullPath),
            Size = size,
            Source = source,
        };
    }

    public static string GuessMimeType(string path)
    {
        string extension = Path.GetExtension(path);
        if (!string.IsNullOrEmpty(extension) && MimeTypes.TryGetValue(extension, out string? mime))
        {
            return mime;
        }

        return "application/octet-stream";
    }
}
