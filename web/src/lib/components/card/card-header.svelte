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

<div bind:this={ref} class={cn("flex flex-col gap-1 px-4 pt-3", className)} {...restProps}>
  {@render children?.()}
</div>
