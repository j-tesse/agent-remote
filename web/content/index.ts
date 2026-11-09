// Co-create renderers by media type (the web half of shared/content.ts's registry).
import type { ComponentType } from "react";
import type { Client } from "../client";
import type { ContentMediaType, ContentPointer } from "../../shared/content";
import { MarkdownPreview } from "./MarkdownPreview";
import { LearnPreview } from "./LearnPreview";

export interface ContentViewProps {
  client: Client;
  sessionId: string;
  folder: string;
  pointer: ContentPointer;
}

export const CONTENT_VIEWS: Record<ContentMediaType, ComponentType<ContentViewProps>> = {
  markdown: MarkdownPreview,
  learn: LearnPreview,
};
