import { Skeleton } from "@/components/ui/skeleton";

const TIMELINE_WIDTHS = [72, 58, 64, 46, 68, 52];
const ROW_WIDTHS = [20, 28, 16];

export default function Loading() {
	return (
		<div aria-hidden="true">
			<div className="mb-8 flex flex-col gap-4">
				<div className="flex items-center gap-2">
					<span className="-ml-2 size-9 shrink-0" />
					<Skeleton className="size-14 shrink-0 rounded-full" />
					<div className="ml-2 flex flex-col gap-2">
						<Skeleton className="h-6 w-40" />
						<Skeleton className="h-3.5 w-52" />
					</div>
				</div>
				<div className="flex gap-5">
					<Skeleton className="h-6 w-20 rounded-full" />
					<Skeleton className="h-4 w-24 self-center" />
					<Skeleton className="h-4 w-20 self-center" />
				</div>
			</div>
			<div className="flex flex-col gap-6">
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					{Array.from({ length: 4 }, (_, index) => (
						<div key={index} className="flex flex-col gap-2.5 rounded-xl bg-card p-4 shadow-border">
							<Skeleton className="h-3 w-20" />
							<Skeleton className="h-6 w-14" />
							<Skeleton className="h-2.5 w-16" />
						</div>
					))}
				</div>
				<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
					<div className="flex flex-col gap-6 lg:order-last">
						{[3, 3].map((rows, card) => (
							<div key={card} className="rounded-xl bg-card shadow-border">
								<div className="flex h-12 items-center px-4">
									<Skeleton className="h-3.5 w-16" />
								</div>
								<div className="divide-y divide-border/60 border-t border-border/60">
									{ROW_WIDTHS.slice(0, rows).map((width, row) => (
										<div key={row} className="flex justify-between px-4 py-3">
											<Skeleton className="h-3 w-16" />
											<Skeleton className="h-3" style={{ width: `${width * 4}px` }} />
										</div>
									))}
								</div>
							</div>
						))}
					</div>
					<div className="rounded-xl bg-card shadow-border">
						<div className="flex h-12 items-center px-4">
							<Skeleton className="h-3.5 w-16" />
						</div>
						<div className="flex flex-col gap-5 border-t border-border/60 p-4">
							{TIMELINE_WIDTHS.map((width, index) => (
								<div key={index} className="flex items-center gap-3">
									<Skeleton className="size-7 shrink-0 rounded-full" />
									<Skeleton className="h-3.5" style={{ width: `${width}%` }} />
									<Skeleton className="ml-auto h-3 w-10" />
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
