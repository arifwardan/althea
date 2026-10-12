<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<p bind:this={ref} class={cn("text-xs text-muted-foreground", className)} {...restProps}>
  {@render children?.()}
</p>
