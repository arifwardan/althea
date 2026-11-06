<script lang="ts">
  import { Tabs } from "bits-ui";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    value,
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<!--
  Tombol tab — meniru tombol .pick di menu tech_stack:
  pill, border --line, teks dim; hover mencerah; aktif
  (data-state="active" dari bits-ui, lihat design/TABS.md)
  jadi hijau seperti .pick.on.
-->
<Tabs.Trigger
  bind:ref
  {value}
  class={cn(
    "inline-flex flex-none cursor-pointer items-center justify-center whitespace-nowrap rounded-full border border-border bg-transparent px-3 py-[5px] text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-success data-[state=active]:bg-[rgba(52,211,153,0.12)] data-[state=active]:text-success-foreground",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</Tabs.Trigger>
