import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";
import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import { directive } from "micromark-extension-directive";
import type { Processor } from "unified";

const COLON = 58;

type Extension = ReturnType<typeof directive>;

/**
 * The micromark extension with only the leaf construct (`::name[label]{attrs}` on its own line).
 * The text form would turn prose like `16:9` and `10:30am` into directives, and the container
 * form (`:::`) isn't part of the format.
 */
function leafDirectiveSyntax(): Extension {
  const flow = directive().flow?.[COLON];
  // The container construct is the only `concrete` one; the package doesn't export the leaf alone.
  const leaf = [flow ?? []].flat().filter((construct) => !construct.concrete);
  if (leaf.length !== 1) throw new Error("micromark-extension-directive changed: no single leaf");
  return { flow: { [COLON]: leaf } };
}

/** Serializes leaf directives, and escapes a typed `::` at the start of a line. */
function leafDirectiveToMarkdown(): ToMarkdownExtension {
  return {
    handlers: { leafDirective: directiveToMarkdown().handlers?.leafDirective },
    unsafe: [
      { character: "\r", inConstruct: ["leafDirectiveLabel"] },
      { character: "\n", inConstruct: ["leafDirectiveLabel"] },
      { atBreak: true, character: ":", after: ":" },
    ],
  };
}

/** Remark plugin: parse and serialize only the leaf form of the directive syntax. */
export function remarkLeafDirective(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(leafDirectiveSyntax());
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(leafDirectiveToMarkdown());
}
