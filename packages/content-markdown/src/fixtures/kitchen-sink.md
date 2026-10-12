# A heading one

Plain text with *emphasis*, **strong**, ***both***, _underscored_ and `inline code`.
A soft line break, then a [link](https://example.com "Title"), an autolink <https://ry-mart.com>,
a bare https://example.org/path and a [reference link][ref].

[ref]: https://example.net/ref

## Times and ratios

The video is 16:9, the talk starts at 10:30am, and C++ uses a::b for scopes.
Emoji shortcodes like :smile: stay as text, and so does note:thing.

:::note
Container syntax is not part of the format.
:::

## Lists

- one
- two
  - nested
- three

1. first
2. second

A paragraph between lists.

7. starts at seven
8. eight

Another paragraph.

- loose item

- another loose item

Tasks:

- [ ] a task
- [x] a done task

## Code

```ts
const answer: number = 42;
```

```python
def retry():
    pass
```

```not-a-language
plain text block
```

```
no language
```

```js title="example.js"
console.log("meta string");
```

    indented code

## Quotes and rules

> A quote with **bold**.
>
> > A nested quote.

---

***

## Tables and more

| Name | Value |
| ---- | ----: |
| a    |     1 |
| b    |     2 |

~~struck~~ text, a footnote[^1], and a hard\
break with two trailing spaces  
here.

[^1]: The footnote.

## Raw HTML is dropped

<div class="x">a div</div>

<script>alert(1)</script>

<!-- a comment -->

Inline <b>bold</b> and <img src="x" onerror="alert(1)"> are stripped.

![An image](https://example.com/a.png "Image title")

Entities: &copy; &amp; &lt;tag&gt; and a literal \*not emphasis\*.

## Repeated heading

## Repeated heading

### A third-level heading

#### Fourth

##### Fifth

###### Sixth
