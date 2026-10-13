import { SHIKI_LANGS, docToMarkdown, markdownToDoc, type DocNode } from "@site/content-markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Heading4,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { editorExtensions, selectedFigure } from "./editor-extensions";
import { ImageDialog, type NewFigure } from "./ImageDialog";

// The rich-text editor (design doc §4.9.3). Its JSON exists only in memory: every change goes
// out as Markdown through the shared bridge, which is what D1 and git store.

/** Plain text that looks like Markdown (a heading, list, quote, fence, emphasis or link). */
const LOOKS_LIKE_MARKDOWN =
  /^(#{2,6} |[-*+] |\d+[.)] |> |```|::figure)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/m;

/** Accepts http(s), mailto and site-relative links; anything else (javascript:, data:) is refused. */
export function safeHref(input: string): string | null {
  const href = input.trim();
  if (!href) return null;
  if (/^(\/(?!\/)|#)/.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Inserts a figure at the selection, or after the figure the selection is in or on. */
function insertFigure(editor: Editor, attrs: NewFigure) {
  const figure = { type: "figure", attrs };
  const { state } = editor;
  const at = selectedFigure(state.selection);
  const chain = editor.chain().focus();
  // Inserting into a caption would split that figure in two, and over a selected one replace it.
  if (at === null) chain.insertContent(figure).run();
  else chain.insertContentAt(at + state.doc.nodeAt(at)!.nodeSize, figure).run();
}

export function RichEditor({
  initialDoc,
  onChange,
  label,
  draftId,
}: {
  initialDoc: DocNode;
  onChange: (markdown: string) => void;
  label: string;
  /** The draft that uploaded images belong to. */
  draftId: string;
}) {
  const editorRef = useRef<Editor | null>(null);
  // useEditor keeps the options it was created with, so the latest callback is read from a ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const editor = useEditor({
    extensions: editorExtensions,
    content: initialDoc,
    // The app server-renders; the editor only exists in the browser.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "prose min-h-[24rem] px-4 py-5 outline-none sm:px-6",
        "aria-label": label,
        "aria-multiline": "true",
        role: "textbox",
      },
      handlePaste(_view, event) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (event.clipboardData?.getData("text/html") || !LOOKS_LIKE_MARKDOWN.test(text)) {
          return false;
        }
        try {
          const doc = markdownToDoc(text);
          editorRef.current
            ?.chain()
            .focus()
            .insertContent(doc.content ?? [])
            .run();
          return true;
        } catch {
          return false;
        }
      },
    },
    onUpdate: ({ editor: updated }) => {
      onChangeRef.current(docToMarkdown(updated.getJSON() as DocNode));
    },
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {editor && <Toolbar editor={editor} onImage={() => fileInput.current?.click()} />}
      <EditorContent editor={editor} />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Picking the same file again should open the dialog again.
          event.currentTarget.value = "";
          if (file) setImageFile(file);
        }}
      />
      {editor && imageFile && (
        <ImageDialog
          file={imageFile}
          draftId={draftId}
          onInsert={(figure) => insertFigure(editor, figure)}
          onClose={() => setImageFile(null)}
        />
      )}
    </div>
  );
}

function Toolbar({ editor, onImage }: { editor: Editor; onImage: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      h4: e.isActive("heading", { level: 4 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      language: (e.getAttributes("codeBlock").language as string | null) ?? "",
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  const editLink = () => {
    const current = (editor.getAttributes("link").href as string | undefined) ?? "";
    const input = window.prompt("Link address (leave empty to remove the link)", current);
    if (input === null) return;
    if (!input.trim()) {
      chain().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = safeHref(input);
    if (!href) {
      window.alert("Use an https:, http: or mailto: address, or a path on this site.");
      return;
    }
    chain().extendMarkRange("link").setLink({ href }).run();
  };

  const buttons: { label: string; icon: LucideIcon; active?: boolean; run: () => void }[][] = [
    [
      {
        label: "Heading 2",
        icon: Heading2,
        active: state.h2,
        run: () => chain().toggleHeading({ level: 2 }).run(),
      },
      {
        label: "Heading 3",
        icon: Heading3,
        active: state.h3,
        run: () => chain().toggleHeading({ level: 3 }).run(),
      },
      {
        label: "Heading 4",
        icon: Heading4,
        active: state.h4,
        run: () => chain().toggleHeading({ level: 4 }).run(),
      },
    ],
    [
      { label: "Bold", icon: Bold, active: state.bold, run: () => chain().toggleBold().run() },
      {
        label: "Italic",
        icon: Italic,
        active: state.italic,
        run: () => chain().toggleItalic().run(),
      },
      {
        label: "Inline code",
        icon: Code,
        active: state.code,
        run: () => chain().toggleCode().run(),
      },
      { label: "Link", icon: LinkIcon, active: state.link, run: editLink },
    ],
    [
      {
        label: "Bulleted list",
        icon: List,
        active: state.bulletList,
        run: () => chain().toggleBulletList().run(),
      },
      {
        label: "Numbered list",
        icon: ListOrdered,
        active: state.orderedList,
        run: () => chain().toggleOrderedList().run(),
      },
      {
        label: "Quote",
        icon: Quote,
        active: state.blockquote,
        run: () => chain().toggleBlockquote().run(),
      },
      {
        label: "Code block",
        icon: SquareCode,
        active: state.codeBlock,
        run: () => chain().toggleCodeBlock().run(),
      },
      { label: "Divider", icon: Minus, run: () => chain().setHorizontalRule().run() },
      { label: "Image", icon: ImagePlus, run: onImage },
    ],
  ];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1.5"
    >
      {buttons.map((group, i) => (
        <div
          key={i}
          className="flex items-center gap-0.5 border-r border-line pr-1 last:border-r-0"
        >
          {group.map(({ label, icon: Icon, active, run }) => (
            <button
              key={label}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={active ?? undefined}
              // Keep the selection in the editor when the button is pressed.
              onMouseDown={(event) => event.preventDefault()}
              onClick={run}
              className="inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-fg aria-pressed:bg-fg aria-pressed:text-bg [&_svg]:size-[18px]"
            >
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
      ))}
      {state.codeBlock && (
        <label className="flex items-center gap-1.5 px-1 text-sm text-muted">
          <span>Language</span>
          <select
            value={state.language}
            onChange={(event) =>
              chain()
                .updateAttributes("codeBlock", { language: event.target.value || null })
                .run()
            }
            className="rounded-lg border border-line bg-surface px-2 py-1 text-fg"
          >
            <option value="">Plain text</option>
            {SHIKI_LANGS.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
            {state.language && !(SHIKI_LANGS as readonly string[]).includes(state.language) && (
              <option value={state.language}>{state.language}</option>
            )}
          </select>
        </label>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {(
          [
            { label: "Undo", icon: Undo2, enabled: state.canUndo, run: () => chain().undo().run() },
            { label: "Redo", icon: Redo2, enabled: state.canRedo, run: () => chain().redo().run() },
          ] as const
        ).map(({ label, icon: Icon, enabled, run }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={run}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40 [&_svg]:size-[18px]"
          >
            <Icon aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
