import katex from "katex";
import "katex/dist/katex.min.css";
import type { CSSProperties } from "react";

type LatexMarkupProps = {
  value: string;
  className: string;
  displayMode?: boolean;
  style?: CSSProperties;
  label?: string;
};

export default function LatexMarkup({ value, className, displayMode = false, style, label }: LatexMarkupProps) {
  return (
    <div
      className={className}
      style={style}
      aria-label={label}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(value, { throwOnError: false, displayMode, trust: false }),
      }}
    />
  );
}
