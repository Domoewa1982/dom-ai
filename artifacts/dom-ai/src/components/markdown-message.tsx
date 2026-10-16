import type { ReactNode } from 'react';

type CitationSource = {
  title: string;
  url: string;
};

const INLINE_TOKEN = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|【\d+†[^】]+】)/g;

function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderInline(text: string, sources: CitationSource[], keyPrefix: string): ReactNode[] {
  return text.split(INLINE_TOKEN).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!part) return null;

    const citation = /^【(\d+)†([^】]+)】$/.exec(part);
    if (citation) {
      const source = sources[Number(citation[1]) - 1];
      if (!source || !isSafeUrl(source.url)) return part;
      return (
        <a
          className="markdown-citation"
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.title}
          key={key}
        >
          [{citation[1]} · {citation[2]}]
        </a>
      );
    }

    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) {
      return isSafeUrl(link[2])
        ? <a href={link[2]} target="_blank" rel="noopener noreferrer" key={key}>{link[1]}</a>
        : part;
    }

    if (/^\*\*.+\*\*$|^__.+__$/.test(part)) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (/^~~.+~~$/.test(part)) {
      return <del key={key}>{part.slice(2, -2)}</del>;
    }
    if (/^`.+`$/.test(part)) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (/^\*.+\*$|^_.+_$/.test(part)) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }

    return part;
  });
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let inCode = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (character === '`') {
      inCode = !inCode;
      cell += character;
    } else if (character === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !lines[index].includes('|')) return false;
  const columns = splitTableRow(lines[index]);
  const separators = splitTableRow(lines[index + 1]);
  return columns.length > 0 &&
    columns.length === separators.length &&
    separators.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]?.trimStart() ?? '';
  return isTableStart(lines, index) ||
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line) ||
    /^(?:-{3,}|_{3,}|\*{3,})$/.test(line);
}

function renderBlocks(text: string, sources: CitationSource[]): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([\w+-]*)/.exec(line.trimStart());
    if (fence) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`block-${blocks.length}`}>
          <code className={fence[1] ? `language-${fence[1]}` : undefined}>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const separators = splitTableRow(lines[index + 1]);
      const alignments = separators.map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : 'left';
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`block-${blocks.length}`} role="region" aria-label="Markdown table" tabIndex={0}>
          <table className="markdown-table">
            <thead>
              <tr>
                {headers.map((header, column) => (
                  <th key={column} style={{ textAlign: alignments[column] ?? 'left' }}>
                    {renderInline(header, sources, `table-head-${blocks.length}-${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, column) => (
                    <td key={column} style={{ textAlign: alignments[column] ?? 'left' }}>
                      {renderInline(row[column] ?? '', sources, `table-cell-${blocks.length}-${rowIndex}-${column}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trimStart());
    if (heading) {
      const Heading = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Heading key={`block-${blocks.length}`}>
          {renderInline(heading[2], sources, `heading-${blocks.length}`)}
        </Heading>,
      );
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={`block-${blocks.length}`} />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line.trimStart())) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trimStart())) {
        quoteLines.push(lines[index].trimStart().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`block-${blocks.length}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={quoteIndex}>{renderInline(quoteLine, sources, `quote-${blocks.length}-${quoteIndex}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const listItem = /^(?:[-*+]\s+|\d+[.)]\s+)/.exec(line.trimStart());
    if (listItem) {
      const ordered = /^\d/.test(listItem[0]);
      const List = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      const itemPattern = ordered ? /^\d+[.)]\s+/ : /^[-*+]\s+/;
      while (index < lines.length && itemPattern.test(lines[index].trimStart())) {
        items.push(lines[index].trimStart().replace(itemPattern, ''));
        index += 1;
      }
      blocks.push(
        <List key={`block-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, sources, `list-${blocks.length}-${itemIndex}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`block-${blocks.length}`}>
        {renderInline(paragraph.join('\n'), sources, `paragraph-${blocks.length}`)}
      </p>,
    );
  }

  return blocks;
}

export function MarkdownMessage({
  text,
  sources = [],
}: {
  text: string;
  sources?: CitationSource[];
}) {
  return <div className="markdown-content">{renderBlocks(text, sources)}</div>;
}
