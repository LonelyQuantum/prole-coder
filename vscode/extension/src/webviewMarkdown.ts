export const WEBVIEW_MARKDOWN_RENDERER_SCRIPT = `
    function appendMarkdownBlocks(parent, markdown) {
      for (const block of renderMarkdownBlocks(markdown)) {
        parent.append(block);
      }
    }

    function renderMarkdownBlocks(markdown) {
      const lines = markdown.replace(/\\r\\n?/g, "\\n").split("\\n");
      const blocks = [];
      let index = 0;

      while (index < lines.length) {
        const line = lines[index];
        if (line.trim().length === 0) {
          index += 1;
          continue;
        }

        if (isFenceStart(line)) {
          const rendered = renderMarkdownCodeFence(lines, index);
          blocks.push(rendered.element);
          index = rendered.nextIndex;
          continue;
        }

        if (isMarkdownTableAt(lines, index)) {
          const rendered = renderMarkdownTable(lines, index);
          blocks.push(rendered.element);
          index = rendered.nextIndex;
          continue;
        }

        if (isMarkdownHorizontalRule(line)) {
          blocks.push(document.createElement("hr"));
          index += 1;
          continue;
        }

        const heading = line.match(/^(#{1,6})\\s+(.+)$/);
        if (heading) {
          const level = Math.min(6, Math.max(3, heading[1].length + 2));
          const element = document.createElement("h" + String(level));
          appendInlineMarkdown(element, heading[2].trim());
          blocks.push(element);
          index += 1;
          continue;
        }

        const listKind = markdownListKind(line);
        if (listKind) {
          const rendered = renderMarkdownList(lines, index, listKind);
          blocks.push(rendered.element);
          index = rendered.nextIndex;
          continue;
        }

        if (/^\\s*>\\s?/.test(line)) {
          const rendered = renderMarkdownBlockquote(lines, index);
          blocks.push(rendered.element);
          index = rendered.nextIndex;
          continue;
        }

        const rendered = renderMarkdownParagraph(lines, index);
        blocks.push(rendered.element);
        index = rendered.nextIndex;
      }

      if (blocks.length === 0) {
        const paragraph = document.createElement("p");
        paragraph.textContent = "";
        return [paragraph];
      }
      return blocks;
    }

    function renderMarkdownCodeFence(lines, startIndex) {
      const fence = markdownFence();
      const firstLine = lines[startIndex].trim();
      const language = firstLine.slice(fence.length).trim();
      const codeLines = [];
      let index = startIndex + 1;
      while (index < lines.length && !isFenceStart(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language.length > 0) {
        code.setAttribute("data-language", language.slice(0, 32));
      }
      code.textContent = codeLines.join("\\n");
      pre.append(code);
      return { element: pre, nextIndex: index };
    }

    function renderMarkdownList(lines, startIndex, kind) {
      const list = document.createElement(kind);
      let index = startIndex;
      while (index < lines.length && markdownListKind(lines[index]) === kind) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, markdownListText(lines[index]));
        list.append(item);
        index += 1;
      }
      return { element: list, nextIndex: index };
    }

    function renderMarkdownBlockquote(lines, startIndex) {
      const quoteLines = [];
      let index = startIndex;
      while (index < lines.length && /^\\s*>\\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\\s*>\\s?/, ""));
        index += 1;
      }

      const blockquote = document.createElement("blockquote");
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, quoteLines.join(" ").trim());
      blockquote.append(paragraph);
      return { element: blockquote, nextIndex: index };
    }

    function renderMarkdownParagraph(lines, startIndex) {
      const paragraphLines = [];
      let index = startIndex;
      while (index < lines.length) {
        const line = lines[index];
        if (
          line.trim().length === 0 ||
          isFenceStart(line) ||
          isMarkdownTableAt(lines, index) ||
          isMarkdownHorizontalRule(line) ||
          /^(#{1,6})\\s+/.test(line) ||
          markdownListKind(line) ||
          /^\\s*>\\s?/.test(line)
        ) {
          break;
        }
        paragraphLines.push(line.trim());
        index += 1;
      }

      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, paragraphLines.join(" "));
      return { element: paragraph, nextIndex: index };
    }

    function renderMarkdownTable(lines, startIndex) {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const tbody = document.createElement("tbody");
      const header = document.createElement("tr");
      for (const cellText of splitMarkdownTableRow(lines[startIndex])) {
        const cell = document.createElement("th");
        appendInlineMarkdown(cell, cellText);
        header.append(cell);
      }
      thead.append(header);

      let index = startIndex + 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim().length > 0) {
        const row = document.createElement("tr");
        for (const cellText of splitMarkdownTableRow(lines[index])) {
          const cell = document.createElement("td");
          appendInlineMarkdown(cell, cellText);
          row.append(cell);
        }
        tbody.append(row);
        index += 1;
      }

      table.append(thead, tbody);
      return { element: table, nextIndex: index };
    }

    function appendInlineMarkdown(parent, text) {
      const marker = markdownBacktick();
      let index = 0;
      while (index < text.length) {
        const codeStart = text.indexOf(marker, index);
        if (codeStart < 0) {
          appendInlineText(parent, text.slice(index));
          return;
        }
        if (codeStart > index) {
          appendInlineText(parent, text.slice(index, codeStart));
        }
        const codeEnd = text.indexOf(marker, codeStart + 1);
        if (codeEnd < 0) {
          appendInlineText(parent, text.slice(codeStart));
          return;
        }
        const code = document.createElement("code");
        code.textContent = text.slice(codeStart + 1, codeEnd);
        parent.append(code);
        index = codeEnd + 1;
      }
    }

    function appendInlineText(parent, text) {
      let index = 0;
      while (index < text.length) {
        const token = findNextInlineToken(text, index);
        if (!token) {
          parent.append(document.createTextNode(text.slice(index)));
          return;
        }
        if (token.start > index) {
          parent.append(document.createTextNode(text.slice(index, token.start)));
        }
        if (token.type === "link") {
          const link = document.createElement("a");
          link.href = token.href;
          link.target = "_blank";
          link.rel = "noreferrer noopener";
          appendInlineText(link, token.label);
          parent.append(link);
        } else if (token.type === "strong") {
          const strong = document.createElement("strong");
          appendInlineText(strong, token.text);
          parent.append(strong);
        } else if (token.type === "em") {
          const emphasis = document.createElement("em");
          appendInlineText(emphasis, token.text);
          parent.append(emphasis);
        }
        index = token.end;
      }
    }

    function findNextInlineToken(text, startIndex) {
      const candidates = [];
      const link = findNextMarkdownLink(text, startIndex);
      if (link) {
        candidates.push(link);
      }
      const strong = findNextDelimitedInline(text, startIndex, "**", "strong");
      if (strong) {
        candidates.push(strong);
      }
      const emphasis = findNextEmphasis(text, startIndex);
      if (emphasis) {
        candidates.push(emphasis);
      }
      candidates.sort((left, right) => left.start - right.start);
      return candidates[0];
    }

    function findNextMarkdownLink(text, startIndex) {
      let searchIndex = startIndex;
      while (searchIndex < text.length) {
        const labelStart = text.indexOf("[", searchIndex);
        if (labelStart < 0) {
          return undefined;
        }
        const labelEnd = text.indexOf("]", labelStart + 1);
        if (labelEnd < 0) {
          return undefined;
        }
        if (text.charAt(labelEnd + 1) !== "(") {
          searchIndex = labelEnd + 1;
          continue;
        }
        const hrefEnd = text.indexOf(")", labelEnd + 2);
        if (hrefEnd < 0) {
          return undefined;
        }
        const href = safeMarkdownHref(text.slice(labelEnd + 2, hrefEnd).trim());
        if (href) {
          return {
            type: "link",
            start: labelStart,
            end: hrefEnd + 1,
            label: text.slice(labelStart + 1, labelEnd),
            href,
          };
        }
        searchIndex = hrefEnd + 1;
      }
      return undefined;
    }

    function findNextDelimitedInline(text, startIndex, delimiter, type) {
      const start = text.indexOf(delimiter, startIndex);
      if (start < 0) {
        return undefined;
      }
      const end = text.indexOf(delimiter, start + delimiter.length);
      if (end < 0) {
        return undefined;
      }
      return {
        type,
        start,
        end: end + delimiter.length,
        text: text.slice(start + delimiter.length, end),
      };
    }

    function findNextEmphasis(text, startIndex) {
      let start = findSingleAsterisk(text, startIndex);
      while (start >= 0) {
        const end = findSingleAsterisk(text, start + 1);
        if (end >= 0) {
          return { type: "em", start, end: end + 1, text: text.slice(start + 1, end) };
        }
        start = findSingleAsterisk(text, start + 1);
      }
      return undefined;
    }

    function findSingleAsterisk(text, startIndex) {
      let index = text.indexOf("*", startIndex);
      while (index >= 0) {
        if (text.charAt(index - 1) !== "*" && text.charAt(index + 1) !== "*") {
          return index;
        }
        index = text.indexOf("*", index + 1);
      }
      return -1;
    }

    function safeMarkdownHref(rawHref) {
      try {
        const parsed = new URL(rawHref);
        if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
          return parsed.toString();
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    function isFenceStart(line) {
      return line.trim().startsWith(markdownFence());
    }

    function markdownFence() {
      return markdownBacktick() + markdownBacktick() + markdownBacktick();
    }

    function markdownBacktick() {
      return String.fromCharCode(96);
    }

    function markdownBackslash() {
      return String.fromCharCode(92);
    }

    function isMarkdownHorizontalRule(line) {
      return /^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$/.test(line);
    }

    function markdownListKind(line) {
      if (/^\\s*[-*+]\\s+/.test(line)) {
        return "ul";
      }
      if (/^\\s*\\d+[.)]\\s+/.test(line)) {
        return "ol";
      }
      return undefined;
    }

    function markdownListText(line) {
      return line.replace(/^\\s*(?:[-*+]|\\d+[.)])\\s+/, "").trim();
    }

    function isMarkdownTableAt(lines, index) {
      if (index + 1 >= lines.length || !lines[index].includes("|")) {
        return false;
      }
      const separatorCells = splitMarkdownTableRow(lines[index + 1]);
      return separatorCells.length > 0 && separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }

    function splitMarkdownTableRow(line) {
      let trimmed = line.trim();
      if (trimmed.startsWith("|")) {
        trimmed = trimmed.slice(1);
      }
      if (trimmed.endsWith("|")) {
        trimmed = trimmed.slice(0, -1);
      }

      const cells = [];
      let current = "";
      let escaped = false;
      for (const char of trimmed) {
        if (escaped) {
          current += char;
          escaped = false;
        } else if (char === markdownBackslash()) {
          escaped = true;
        } else if (char === "|") {
          cells.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    }
`;
