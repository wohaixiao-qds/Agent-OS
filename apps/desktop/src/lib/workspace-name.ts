/**
 * Default workspace display name: the folder's last path segment.
 * Handles both separators and trailing slashes ("/a/b/", "E:\\proj\\repo").
 */
export function folderLastName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}
