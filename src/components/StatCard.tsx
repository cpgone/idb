import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowUpRight, Info, LucideIcon } from "lucide-react";
import type { FocusEventHandler, MouseEventHandler, ReactNode } from "react";

type TrendBarsProps = {
  values: number[];
  color?: string;
};

const TrendBars = ({ values, color = "hsl(var(--foreground))" }: TrendBarsProps) => {
  if (!values.length) return null;
  const lastValues = values.slice(-10); // keep the sparkline compact
  const max = Math.max(...lastValues, 0);
  return (
    <div
      className="flex h-8 w-16 items-end gap-[3px] rounded-md bg-muted/70 px-2 py-1"
      aria-hidden
    >
      {lastValues.map((val, idx) => {
        const height = max > 0 ? Math.max(2, (val / max) * 28) : 2;
        return (
          <div
            key={idx}
            className="w-[6px] rounded-sm"
            style={{ height, background: color }}
          />
        );
      })}
    </div>
  );
};

interface StatCardProps {
  title: string;
  value: ReactNode;
  icon?: LucideIcon;
  trend?: {
    values: number[];
    color?: string;
  };
  headerRight?: ReactNode;
  info?: {
    label?: string;
    content: ReactNode;
  };
  onClick?: () => void;
  actionLabel?: string;
  valueClassName?: string;
  footerNote?: ReactNode;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onBlur?: FocusEventHandler<HTMLDivElement>;
}

export const StatCard = ({
  title,
  value,
  icon: Icon,
  trend,
  headerRight,
  info,
  onClick,
  actionLabel,
  valueClassName,
  footerNote,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: StatCardProps) => {
  return (
    <Card
      className={`relative p-4 transition-all hover:shadow-lg border-border/50 ${
        onClick ? "cursor-pointer" : ""
      }`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="text-sm sm:text-base font-medium text-muted-foreground">
            {title}
          </p>
          {info ? (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={info.label ?? "Info"}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" align="start" className="max-w-[260px] text-xs">
                  {info.content}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        <div className="rounded-lg flex items-center justify-center">
          {headerRight ? (
            headerRight
          ) : trend ? (
            <TrendBars values={trend.values} color={trend.color} />
          ) : Icon ? (
            <div className="bg-primary/10 rounded-lg p-1.5 sm:p-2">
              <Icon className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-[104px] items-start justify-center pt-2">
        <div
          className={`text-4xl sm:text-5xl font-bold text-foreground leading-tight ${valueClassName ?? ""}`}
        >
          {value}
        </div>
      </div>
      {footerNote ? (
        <div className="pointer-events-none absolute bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs sm:text-sm font-semibold text-foreground">
          {footerNote}
        </div>
      ) : null}
      {actionLabel && (
        <div className="absolute bottom-2 right-3 inline-flex items-center gap-1 text-[11px] sm:text-xs font-semibold text-primary">
          <span className="lowercase">{actionLabel}</span>
          <ArrowUpRight className="h-3 w-3" />
        </div>
      )}
    </Card>
  );
};
