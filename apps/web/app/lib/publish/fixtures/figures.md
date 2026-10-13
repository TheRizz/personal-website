Figures where the editor can put them, and lines that only look like figures.

> A quote with a figure:
>
> ::figure[In a *quote*]{src="blog/11111111-2222-4333-8444-555555555555.webp" alt="Quoted" w="1600" h="900"}

- A list item

  ::figure{src='blog/22222222-3333-4444-8555-666666666666.jpg' alt='Single quotes' size=wide w=800 h=600}

- ::figure[Straight in the item]{src=blog/33333333-4444-4555-8666-777777777777.png alt=Unquoted w=300 h=200}

1. Ordered

   1) Nested

      ::figure[A [nested \] bracket] caption]{src="blog/44444444-5555-4666-8777-888888888888.gif" alt="Nested &amp; &#x41;nimated &#34;GIF&#x22;" size="full" w="2048" h="1024"}

::figure{ src = "blog/11111111-2222-4333-8444-555555555555.webp"   alt="Again, spaced out"	w="1600" h="900" }

```md
::figure{src="blog/55555555-6666-4777-8888-999999999999.webp" alt="In a fence" w="10" h="10"}
```

~~~~
```
::figure{src="blog/66666666-7777-4888-8999-aaaaaaaaaaaa.webp" alt="Still fenced" w="10" h="10"}
~~~~

\::figure[typed, not an image]{src="x"}

:: not a directive

:::note
Container syntax is not part of the format.
:::

C++ uses a::b, and ::figure mid-line is text.
