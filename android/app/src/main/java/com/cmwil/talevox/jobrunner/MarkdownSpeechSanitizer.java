package com.cmwil.talevox.jobrunner;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Minimal Markdown -> speech-safe text conversion for native WorkManager jobs.
 *
 * This intentionally prioritizes readability and stability over full Markdown fidelity.
 */
public final class MarkdownSpeechSanitizer {
    private static final Pattern FENCED_CODE_BLOCK = Pattern.compile("```[\\s\\S]*?```");
    private static final Pattern HTML_BR = Pattern.compile("(?i)<br\\s*/?>");
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");
    private static final Pattern IMAGE = Pattern.compile("!\\[([^\\]]*)\\]\\([^)]+\\)");
    private static final Pattern LINK = Pattern.compile("\\[([^\\]]+)\\]\\([^)]+\\)");
    private static final Pattern HEADING = Pattern.compile("(?m)^\\s{0,3}#{1,6}\\s+");
    private static final Pattern BLOCKQUOTE = Pattern.compile("(?m)^\\s{0,3}>\\s?");
    private static final Pattern BULLET = Pattern.compile("(?m)^\\s*[-*+]\\s+");
    private static final Pattern ORDERED = Pattern.compile("(?m)^\\s*\\d+\\.\\s+");
    private static final Pattern INLINE_CODE = Pattern.compile("`([^`]+)`");
    private static final Pattern EMPHASIS = Pattern.compile("(\\*\\*|__|\\*|_)");
    private static final Pattern TRAILING_WS = Pattern.compile("[ \\t]+\\n");
    private static final Pattern MULTI_NL = Pattern.compile("\\n{3,}");
    private static final Pattern BOM = Pattern.compile("\\uFEFF");
    private static final Pattern ZERO_WIDTH = Pattern.compile("[\\u200B-\\u200D\\u2060]");
    private static final Pattern TABLE_SEPARATOR_CELL = Pattern.compile("^:?-{3,}:?$");

    private MarkdownSpeechSanitizer() {}

    public static String sanitize(String markdown) {
        if (markdown == null) return "";

        String text = markdown.replace("\r\n", "\n").replace("\r", "\n");
        text = BOM.matcher(text).replaceAll("");
        text = ZERO_WIDTH.matcher(text).replaceAll("");

        text = FENCED_CODE_BLOCK.matcher(text).replaceAll("");
        text = convertGfmTables(text);

        // Only normalize <br> after table conversion so we don't split table rows.
        text = HTML_BR.matcher(text).replaceAll("\n");

        text = IMAGE.matcher(text).replaceAll("$1");
        text = LINK.matcher(text).replaceAll("$1");
        text = HEADING.matcher(text).replaceAll("");
        text = BLOCKQUOTE.matcher(text).replaceAll("");
        text = BULLET.matcher(text).replaceAll("");
        text = ORDERED.matcher(text).replaceAll("");
        text = INLINE_CODE.matcher(text).replaceAll("$1");
        text = EMPHASIS.matcher(text).replaceAll("");
        text = HTML_TAG.matcher(text).replaceAll("");

        text = TRAILING_WS.matcher(text).replaceAll("\n");
        text = MULTI_NL.matcher(text).replaceAll("\n\n");
        return text.trim();
    }

    private static String convertGfmTables(String input) {
        if (input == null || input.isEmpty()) return input == null ? "" : input;
        String[] lines = input.replace("\r\n", "\n").replace("\r", "\n").split("\n", -1);
        StringBuilder out = new StringBuilder();

        int i = 0;
        while (i < lines.length) {
            String line = lines[i];
            String next = (i + 1) < lines.length ? lines[i + 1] : null;
            List<String> headerCells = parseTableRow(line);

            if (headerCells == null || next == null || !isSeparatorRow(next)) {
                out.append(line);
                if (i < lines.length - 1) out.append("\n");
                i += 1;
                continue;
            }

            List<String> headers = new ArrayList<>();
            for (String h : headerCells) headers.add(cleanInline(h));

            List<String> tableLines = new ArrayList<>();
            i += 2; // skip header + separator

            while (i < lines.length) {
                List<String> rowCells = parseTableRow(lines[i]);
                if (rowCells == null) break;

                List<String> cells = new ArrayList<>();
                for (String c : rowCells) cells.add(cleanInline(c));

                if (cells.size() == 1) {
                    String value = cells.get(0);
                    if (!isBlank(value)) tableLines.add(value);
                    i += 1;
                    continue;
                }

                if (cells.size() >= 2) {
                    if (cells.size() == 2 && headers.size() == 2) {
                        String label = cells.get(0);
                        String value = cells.get(1);
                        if (!isBlank(label) && !isBlank(value)) tableLines.add(label + ": " + value);
                    } else {
                        List<String> parts = new ArrayList<>();
                        int limit = Math.min(headers.size(), cells.size());
                        for (int c = 0; c < limit; c += 1) {
                            String h = headers.get(c);
                            String v = cells.get(c);
                            if (isBlank(v)) continue;
                            if (!isBlank(h)) parts.add(h + ": " + v);
                            else parts.add(v);
                        }
                        if (!parts.isEmpty()) tableLines.add(join(parts, ", "));
                    }
                }

                i += 1;
            }

            if (!tableLines.isEmpty()) {
                out.append("\n");
                for (String t : tableLines) {
                    out.append(t).append("\n");
                }
                out.append("\n");
            }

            // i now points at the first non-table-row line (or EOF); do not increment
            // so the outer loop can process it normally.
        }

        return out.toString();
    }

    private static List<String> parseTableRow(String line) {
        if (line == null) return null;
        String trimmed = line.trim();
        if (!trimmed.contains("|")) return null;

        String withoutOuter = (trimmed.startsWith("|") && trimmed.endsWith("|"))
            ? trimmed.substring(1, trimmed.length() - 1)
            : trimmed;

        String[] parts = withoutOuter.split("\\|", -1);
        List<String> cells = new ArrayList<>(parts.length);
        for (String p : parts) cells.add(p.trim());
        return cells;
    }

    private static boolean isSeparatorRow(String line) {
        List<String> cells = parseTableRow(line);
        if (cells == null) return false;
        for (String c : cells) {
            if (!TABLE_SEPARATOR_CELL.matcher(c).matches()) return false;
        }
        return true;
    }

    private static String cleanInline(String input) {
        if (input == null) return "";
        String out = input;
        out = INLINE_CODE.matcher(out).replaceAll("$1");
        out = EMPHASIS.matcher(out).replaceAll("");
        out = LINK.matcher(out).replaceAll("$1");
        out = IMAGE.matcher(out).replaceAll("$1");
        return out.trim();
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    private static String join(List<String> parts, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i += 1) {
            if (i > 0) sb.append(sep);
            sb.append(parts.get(i));
        }
        return sb.toString();
    }
}
