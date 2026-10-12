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

<div bind:this={ref} class={cn("flex items-center gap-2 border-t border-border px-4 py-2.5", className)} {...restProps}>
  {@render children?.()}
</div>
