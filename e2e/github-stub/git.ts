import { createHash } from "node:crypto";

// The stub's git model (contract §11.3): blobs keyed by their real git blob SHA, trees as flat
// `path → blob` maps, commits and refs. Tree OIDs, and the OID of the `content/blog` directory,
// are content-addressed, so equal trees get equal OIDs across resets and the Worker's tree-OID
// cache of the posts list stays valid. Commit SHAs never repeat, as on GitHub.

/** A git identity as the commits API takes it. */
export interface Person {
  name: string;
  email: string;
}

export interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: Person | null;
  committer: Person | null;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** The git blob SHA of `text`, as `git hash-object` computes it. */
export function blobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

/** Commit SHAs come from this counter too, so a reset never hands out an earlier SHA again. */
let commitCount = 0;

export class GitRepo {
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();

  /** A repository whose `main` has one commit holding `files` (path → text). */
  constructor(files: Map<string, string>) {
    const tree = this.addTree(
      new Map([...files].map(([path, text]) => [path, this.addBlob(text)])),
    );
    this.refs.set("main", this.addCommit({ tree, parents: [], message: "Initial commit" }));
  }

  addBlob(text: string): string {
    const sha = blobSha(text);
    this.blobs.set(sha, text);
    return sha;
  }

  addTree(files: Map<string, string>): string {
    const lines = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sha = sha1(`tree\n${lines.map(([path, blob]) => `${path}\0${blob}`).join("\n")}`);
    this.trees.set(sha, new Map(lines));
    return sha;
  }

  addCommit(commit: {
    tree: string;
    parents: string[];
    message: string;
    author?: Person | null;
    committer?: Person | null;
  }): string {
    const sha = sha1(`commit ${++commitCount}\n${commit.tree}\n${commit.parents.join(" ")}`);
    this.commits.set(sha, {
      sha,
      tree: commit.tree,
      parents: commit.parents,
      message: commit.message,
      author: commit.author ?? null,
      committer: commit.committer ?? null,
    });
    return sha;
  }

  /** A branch name or a commit SHA, as the commit SHA it names; null when it names nothing. */
  resolve(ref: string): string | null {
    const sha = this.refs.get(ref) ?? ref;
    return this.commits.has(sha) ? sha : null;
  }

  /** The files (path → blob SHA) of a commit; empty for an unknown commit. */
  filesAt(commitSha: string): Map<string, string> {
    const commit = this.commits.get(commitSha);
    return new Map((commit && this.trees.get(commit.tree)) ?? []);
  }

  /** The text of the file at `path` in a commit, with its blob SHA, or null. */
  fileAt(commitSha: string, path: string): { sha: string; text: string } | null {
    const sha = this.filesAt(commitSha).get(path);
    const text = sha === undefined ? undefined : this.blobs.get(sha);
    return sha === undefined || text === undefined ? null : { sha, text };
  }

  /**
   * The `content/blog` directory of a commit: its direct children (a file, or a subdirectory
   * name) and a content-addressed OID; null when the directory doesn't exist.
   */
  blogDirectory(
    commitSha: string,
  ): { oid: string; entries: { name: string; type: "blob" | "tree"; oid: string }[] } | null {
    const prefix = "content/blog/";
    const children = new Map<string, { type: "blob" | "tree"; oid: string }>();
    const nested = new Map<string, string[]>();
    for (const [path, blob] of this.filesAt(commitSha)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) children.set(rest, { type: "blob", oid: blob });
      else {
        const name = rest.slice(0, slash);
        nested.set(name, [...(nested.get(name) ?? []), `${rest}\0${blob}`]);
      }
    }
    for (const [name, lines] of nested) {
      children.set(name, { type: "tree", oid: sha1(`tree ${name}\n${lines.sort().join("\n")}`) });
    }
    if (children.size === 0) return null;
    const entries = [...children]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const oid = sha1(`blog\n${entries.map((e) => `${e.type} ${e.name}\0${e.oid}`).join("\n")}`);
    return { oid, entries };
  }

  /** Whether `ancestor` is `of` or one of its ancestors. */
  isAncestor(ancestor: string, of: string): boolean {
    const seen = new Set<string>();
    const queue = [of];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  /** `identical`, `ahead`, `behind` or `diverged`, as GitHub's compare reports `head` against `base`. */
  compare(base: string, head: string): string {
    if (base === head) return "identical";
    if (this.isAncestor(base, head)) return "ahead";
    if (this.isAncestor(head, base)) return "behind";
    return "diverged";
  }

  /** The commits on `head` that `base` doesn't have, oldest first (first parents only). */
  commitsBetween(base: string, head: string): Commit[] {
    const result: Commit[] = [];
    let sha: string | undefined = head;
    while (sha !== undefined && !this.isAncestor(sha, base)) {
      const commit = this.commits.get(sha);
      if (!commit) break;
      result.unshift(commit);
      sha = commit.parents[0];
    }
    return result;
  }

  /** The newest commit on `head`'s first-parent line that `other` also has. */
  mergeBase(head: string, other: string): string | null {
    let sha: string | undefined = head;
    while (sha !== undefined) {
      if (this.isAncestor(sha, other)) return sha;
      sha = this.commits.get(sha)?.parents[0];
    }
    return null;
  }

  /**
   * Squash and merge: the branch's changes against its merge base, applied to `main`'s current
   * tree as one new commit on `main`. Returns the new commit's SHA.
   */
  squashMerge(head: string, message: string, author: Person | null): string {
    const main = this.refs.get("main")!;
    const base = this.mergeBase(head, main);
    const before = base === null ? new Map<string, string>() : this.filesAt(base);
    const after = this.filesAt(head);
    const files = this.filesAt(main);
    for (const [path, blob] of after) if (before.get(path) !== blob) files.set(path, blob);
    for (const path of before.keys()) if (!after.has(path)) files.delete(path);
    const sha = this.addCommit({
      tree: this.addTree(files),
      parents: [main],
      message,
      author,
      committer: { name: "GitHub", email: "noreply@github.com" },
    });
    this.refs.set("main", sha);
    return sha;
  }

  /** Writes (or, with null, deletes) a file on `main` as one direct commit. */
  commitToMain(path: string, text: string | null): string {
    const main = this.refs.get("main")!;
    const files = this.filesAt(main);
    if (text === null) files.delete(path);
    else files.set(path, this.addBlob(text));
    const sha = this.addCommit({
      tree: this.addTree(files),
      parents: [main],
      message: `Update ${path}`,
      author: { name: "TheRizz", email: "19941577+TheRizz@users.noreply.github.com" },
    });
    this.refs.set("main", sha);
    return sha;
  }
}
