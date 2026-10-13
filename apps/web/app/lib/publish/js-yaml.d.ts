// js-yaml 3 ships no types. Only `safeLoad` is used (post-parse.ts), the loader gray-matter calls.
declare module "js-yaml" {
  export function safeLoad(text: string, options?: object): unknown;
}
