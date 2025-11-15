import url from "url";
import { createRunner } from "@puppeteer/replay";
import { config } from "./config.js";

export async function run(extension) {
  const runner = await createRunner(extension);

  await runner.runBeforeAllSteps();

  await runner.runStep({
    type: "setViewport",
    width: 795,
    height: 759,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    isLandscape: false,
  });
  await runner.runStep({
    type: "navigate",
    url: config.websiteUrl,
    assertedEvents: [
      {
        type: "navigation",
        url: config.websiteUrl,
        title: "Create",
      },
    ],
  });
  await runner.runStep({
    type: "click",
    target: "main",
    selectors: [
      ["#pageScroll"],
      ['xpath///*[@id="pageScroll"]'],
      ["pierce/#pageScroll"],
    ],
    offsetY: 95,
    offsetX: 166,
  });
  await runner.runStep({
    type: "click",
    target: "main",
    selectors: [
      ["aria/What will you imagine?"],
      ["#desktop_input_bar"],
      ['xpath///*[@id="desktop_input_bar"]'],
      ["pierce/#desktop_input_bar"],
    ],
    offsetY: 20,
    offsetX: 36,
  });
  await runner.runStep({
    type: "keyDown",
    target: "main",
    key: "Meta",
  });
  await runner.runStep({
    type: "keyDown",
    target: "main",
    key: "v",
  });
  await runner.runStep({
    type: "keyUp",
    key: "Meta",
    target: "main",
  });
  await runner.runStep({
    type: "keyUp",
    key: "v",
    target: "main",
  });
  await runner.runStep({
    type: "click",
    target: "main",
    selectors: [
      ["aria/Submit", 'aria/[role="graphics-symbol"]'],
      ["div.flex-1 div.flex-col > div > button:nth-of-type(1) path"],
      ['xpath///*[@id="PaperAirplane"]/path'],
      ["pierce/div.flex-1 div.flex-col > div > button:nth-of-type(1) path"],
    ],
    offsetY: 13.832942962646484,
    offsetX: 5.382659912109375,
  });

  await runner.runAfterAllSteps();
}

if (process && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  run();
}
