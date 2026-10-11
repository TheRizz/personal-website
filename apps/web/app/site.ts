/** Site-wide settings. Edit these to change the name, intro text and links. */
export const site = {
  name: "ry-mart",
  url: "https://ry-mart.com",
  description: "Writing, code snippets, photos and small games.",
  // TODO: replace with your own intro.
  intro: {
    heading: "Hi there.",
    body: "I build software and write about it here: long-form posts, short snippets I keep reaching for, photos, and a few small games.",
  },
  email: "hello@ry-mart.com",
  github: "https://github.com/TheRizz",
  nav: [
    { label: "Blog", to: "/blog" },
    { label: "Snippets", to: "/snippets" },
    { label: "Photos", to: "/photos" },
    { label: "Resume", to: "/resume" },
    { label: "Games", to: "/games" },
  ],
} as const;
