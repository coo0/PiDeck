import { useEffect, useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "./button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "../../lib/utils";

/**
 * 可搜索下拉（combobox）：点开是带输入框的列表，适合「几十到几百个候选」的设置项。
 *
 * 为什么不用 `Select`：系统字体在 macOS 上就有 350+ 族、Windows/Linux 更多，
 * Radix Select 没有输入过滤，靠滚动找一个字体名不可用；也不适合 `CommandDialog`
 * （居中大弹窗对设置页一行控件过重）。Popover + cmdk 是本仓已有原语的组合，
 * 保持设置页的紧凑观感与可搜索性。
 *
 * 默认项（跟随 X）作为列表第一项渲染：选择它即把值置回空串/null，
 * 与「未设置 = 跟随继承」的既有语义一致，不需要额外的清除按钮。
 */
export type ComboboxOption = {
	/** 选中后写入的值；默认项用空串表示「未设置」 */
	value: string;
	label: string;
	/** 次要说明（如「跟随外观设置」），渲染在标签右侧 */
	hint?: string;
	/** 关键字：参与过滤，补充 label 之外的搜索别名 */
	keywords?: string;
};

export function Combobox(props: {
	value: string;
	options: readonly ComboboxOption[];
	onValueChange: (value: string) => void;
	/** 触发器占位文案（value 为空时显示） */
	placeholder: string;
	/** 列表搜索框占位文案 */
	searchPlaceholder: string;
	/** 空结果文案 */
	emptyLabel: string;
	/** 触发器无障碍名 */
	ariaLabel: string;
	/** 列表宽度（px）；缺省与触发器同宽 */
	listWidth?: number;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const selected = useMemo(() => props.options.find((option) => option.value === props.value), [props.options, props.value]);
	// cmdk 的受控高亮：列表打开时把当前值滚入视口（默认项在首位，通常已是首项）
	const [search, setSearch] = useState("");
	useEffect(() => {
		if (!open) setSearch("");
	}, [open]);

	const filtered = useMemo(() => {
		const keyword = search.trim().toLowerCase();
		if (!keyword) return props.options;
		// 子串匹配（含 keywords）：字体名场景下 fuzzy 会把不同族全命中，反而更难定位
		return props.options.filter((option) => `${option.label} ${option.keywords ?? ""}`.toLowerCase().includes(keyword));
	}, [props.options, search]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={props.ariaLabel} className={cn("w-full justify-between gap-2 font-normal", props.className)}>
					<span className={cn("truncate", !selected && "text-muted-foreground")}>{selected ? selected.label : props.placeholder}</span>
					<ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] gap-0 p-0" style={props.listWidth ? { width: props.listWidth } : undefined}>
				<Command shouldFilter={false} className="bg-transparent">
					<CommandInput autoFocus placeholder={props.searchPlaceholder} value={search} onValueChange={setSearch} />
					<CommandList className="max-h-[min(260px,32vh)]">
						<CommandEmpty className="py-4 text-xs">{props.emptyLabel}</CommandEmpty>
						{filtered.map((option) => (
							<CommandItem
								key={option.value || "__unset__"}
								value={option.value || "__unset__"}
								onSelect={() => {
									props.onValueChange(option.value);
									setOpen(false);
								}}
								className="gap-1.5"
							>
								<span className="truncate">{option.label}</span>
								{option.hint ? <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{option.hint}</span> : null}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
