import { GrayImage } from "../../graphics/image";
import { wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import type { AssistantQuestionPrompt } from "../../assistant/types";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../gestures";
import type { Layer, LayerContext } from "../layers";
import { lineStep } from "../metrics";
import { traceAssistantStage } from "../../native/assistant-trace";

type QuestionPage = { text: string; optionIndex: number | null };

const MARGIN = 20;
const TITLE_Y = 16;
const BODY_Y = 44;
const FOOTER_MARGIN = 18;

/** Explicit, paged confirmation UI. A question page can never select a choice. */
export class AssistantQuestionLayer implements Layer {
  private questionIndex = 0;
  private pageIndex = 0;
  private paintedPageIndex: number | null = null;
  private pages: QuestionPage[] = [];
  private readonly answers: Record<string, number[]> = {};
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onAbort = () => this.finish(null);

  constructor(
    private readonly prompt: AssistantQuestionPrompt,
    private readonly onResolve: (answer: Record<string, number[]> | null) => void,
  ) {
    if (!isSupportedAssistantQuestionPrompt(prompt)) {
      this.finish(null);
      return;
    }
    if (prompt.signal.aborted || prompt.expiresAtMs <= Date.now()) {
      this.finish(null);
      return;
    }
    prompt.signal.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(this.onAbort, prompt.expiresAtMs - Date.now());
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const font = getDefaultSmallFont();
    const question = this.prompt.questions[this.questionIndex];
    if (!question) return image;
    this.pages = buildPages(this.prompt, this.questionIndex, width, height);
    this.pageIndex = Math.min(this.pageIndex, this.pages.length - 1);
    const page = this.pages[this.pageIndex]!;
    image.fillRect(8, 8, width - 16, height - 16, 1);
    image.drawRect(8, 8, width - 16, height - 16, 90);
    image.drawText(font, MARGIN, TITLE_Y,
      `Confirmation ${this.questionIndex + 1}/${this.prompt.questions.length}  Page ${this.pageIndex + 1}/${this.pages.length}`, 220);
    const lines = wrapText(font, page.text, width - 2 * MARGIN, { breakLongWords: true });
    const step = lineStep(font);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, MARGIN, BODY_Y + index * step, lines[index]!, 225);
    }
    const footer = page.optionIndex === null
      ? `scroll for choices  ${GESTURE_DOUBLE_CLICK} cancel`
      : `click choose  scroll  ${GESTURE_DOUBLE_CLICK} cancel`;
    image.drawText(font, MARGIN, height - FOOTER_MARGIN, footer, 110);
    if (this.paintedPageIndex === null) traceAssistantStage("question.paint");
    this.paintedPageIndex = this.pageIndex;
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (this.settled) return;
    if (event.type === "double-click") {
      this.finish(null, ctx);
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const delta = event.type === "scroll-up" ? -1 : 1;
      this.pageIndex = Math.max(0, Math.min(this.pages.length - 1, this.pageIndex + delta));
      ctx.actions.requestRender();
      return;
    }
    if (event.type !== "click") return;
    if (this.paintedPageIndex !== this.pageIndex) return;
    const page = this.pages[this.pageIndex];
    if (!page || page.optionIndex === null) return;
    const question = this.prompt.questions[this.questionIndex]!;
    this.answers[question.questionId] = [page.optionIndex];
    if (++this.questionIndex < this.prompt.questions.length) {
      this.pageIndex = 0;
      this.paintedPageIndex = null;
      this.pages = [];
      ctx.actions.requestRender();
    } else {
      this.finish(this.answers, ctx);
    }
  }

  onRemoved(): void {
    this.finish(null);
  }

  private finish(answer: Record<string, number[]> | null, ctx?: LayerContext): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.prompt.signal.removeEventListener("abort", this.onAbort);
    this.onResolve(answer);
    if (ctx) {
      ctx.stack.remove(this);
      ctx.actions.requestRender();
    }
  }
}

export function isSupportedAssistantQuestionPrompt(prompt: AssistantQuestionPrompt): boolean {
  return prompt.questions.length >= 1 && prompt.questions.length <= 3 &&
    prompt.questions.every((question) => !question.multiSelect && question.options.length > 0);
}

function buildPages(prompt: AssistantQuestionPrompt, questionIndex: number, width: number, height: number): QuestionPage[] {
  const font = getDefaultSmallFont();
  const question = prompt.questions[questionIndex]!;
  const linesPerPage = Math.max(1, Math.floor((height - BODY_Y - 2 * FOOTER_MARGIN) / lineStep(font)));
  const make = (text: string, optionIndex: number | null, pageLines = linesPerPage): QuestionPage[] => {
    const lines = wrapText(font, text, width - 2 * MARGIN, { breakLongWords: true });
    const pages: QuestionPage[] = [];
    for (let index = 0; index < lines.length; index += pageLines) {
      const last = index + pageLines >= lines.length;
      pages.push({ text: lines.slice(index, index + pageLines).join("\n"), optionIndex: last ? optionIndex : null });
    }
    return pages;
  };
  const questionText = question.header?.trim() ? `${question.header.trim()}\n${question.question}` : question.question;
  const questionLines = wrapText(font, questionText, width - 2 * MARGIN, { breakLongWords: true });
  // Keep short questions above every choice; long action previews remain complete reading pages.
  const pinned = questionLines.length <= Math.min(3, linesPerPage - 3);
  const pages = pinned ? [] : make(questionText, null);
  for (let index = 0; index < question.options.length; index++) {
    const option = question.options[index]!;
    const value = option.value && option.value !== option.label ? `\nValue: ${option.value}` : "";
    const description = option.description ? `\n${option.description}` : "";
    const choices = make(`Choice ${index + 1} of ${question.options.length}\n${option.label}${value}${description}`,
      index, pinned ? linesPerPage - questionLines.length - 1 : linesPerPage);
    pages.push(...choices.map(page => pinned ? { ...page, text: `${questionText}\n\n${page.text}` } : page));
  }
  return pages;
}
