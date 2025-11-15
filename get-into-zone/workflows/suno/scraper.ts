export function scrapeSunoMusic() {
  const musicItems = document.querySelectorAll('div[data-testid="clip-row"]')
  const results = []

  musicItems.forEach((item) => {
    const titleElement = item.querySelector(
      "a.hover\\:underline"
    ) as HTMLElement
    const promptElement = item.querySelector(
      ".css-ingj1g.er4jr4i14"
    ) as HTMLElement
    const title = titleElement ? titleElement.textContent : null
    const prompt = promptElement ? promptElement.textContent : null
    const songId = titleElement
      ? (titleElement as HTMLAnchorElement)
          .getAttribute("href")
          ?.split("/")
          .pop()
      : null

    results.push({
      title,
      prompt,
      audioUrl: songId ? `https://cdn1.suno.ai/${songId}.m4a` : null,
      htmlUrl: songId ? `https://suno.com/song/${songId}` : null
    })
  })

  return results
}
