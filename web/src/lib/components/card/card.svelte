<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.ts";

  // "default" — card biasa (bg-card).
  // "nested" — card di dalam card: latar lebih gelap (bg-inset),
  // border lebih lembut (border-muted).
  type CardVariant = "default" | "nested";

  let {
    ref = $bindable(null),
    variant = "default",
    class: className = "",
    children,
    ...restProps
  } = $props();

  const styles: Record<CardVariant, string> = {
    default: "rounded-lg border border-border bg-card text-card-foreground",
    nested: "rounded-lg border border-muted bg-inset text-card-foreground",
  };

  const v = $derived(variant as CardVariant);
</script>

<div bind:this={ref} class={cn(styles[v], className)} {...restProps}>
  {@render children?.()}
</div>
