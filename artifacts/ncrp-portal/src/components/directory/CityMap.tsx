import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useListLore, type LoreEntrySummary } from "@workspace/api-client-react";
import { districtLabel, type DistrictValue } from "@/lib/districts";
import mapImage from "@assets/gk5g5y2f1ln81_1784064405878.jpg";

// Polygons are hand-traced against the source map image
// (attached_assets/gk5g5y2f1ln81_1784064405878.jpg, 1900x2300 px), following
// the colored district borders drawn on the map. Coordinates are in the
// image's native pixel space; the SVG viewBox keeps them aligned at any
// rendered size.
const VIEW_W = 1900;
const VIEW_H = 2300;

type DistrictShape = {
  value: DistrictValue;
  color: string;
  labelPos: [number, number];
  points: string;
};

const DISTRICT_SHAPES: DistrictShape[] = [
  {
    value: "watson",
    color: "#ef4444",
    labelPos: [700, 460],
    points:
      "723,195 890,222 970,297 979,436 927,556 857,653 779,757 612,775 556,810 464,779 400,700 352,612 380,491 454,371 556,278",
  },
  {
    value: "westbrook",
    color: "#f97316",
    labelPos: [1060, 890],
    points:
      "979,436 1085,594 1280,826 1271,965 1187,1085 1048,1150 937,1094 890,988 872,946 825,812 857,653 927,556",
  },
  {
    value: "city_center",
    color: "#eab308",
    labelPos: [720, 910],
    points:
      "594,801 825,812 872,946 844,983 733,1011 519,1002 427,909 404,868 442,844 520,846",
  },
  {
    value: "heywood",
    color: "#22c55e",
    labelPos: [720, 1150],
    points:
      "519,1002 733,1011 844,983 872,946 890,988 937,1094 900,1210 790,1285 640,1305 520,1215 479,1090",
  },
  {
    value: "santo_domingo",
    color: "#3b82f6",
    labelPos: [1080, 1300],
    points:
      "937,1094 1048,1150 1187,1085 1240,1140 1269,1247 1251,1404 1161,1539 1048,1579 947,1523 897,1404 890,1258 900,1210",
  },
  {
    value: "pacifica",
    color: "#a855f7",
    labelPos: [640, 1470],
    points:
      "563,1330 743,1298 811,1348 822,1460 789,1573 676,1644 541,1622 451,1523 462,1404",
  },
  {
    value: "north_badlands",
    color: "#64748b",
    labelPos: [520, 130],
    points:
      "0,0 1900,0 1900,420 1300,420 985,470 979,436 970,297 890,222 723,195 556,278 200,400 0,300",
  },
  {
    value: "eastern_badlands",
    color: "#0ea5e9",
    labelPos: [1580, 1180],
    points: "1300,420 1900,420 1900,1950 1350,1850 1282,1450 1290,741 1300,540",
  },
  {
    value: "southern_badlands",
    color: "#78716c",
    labelPos: [450, 1900],
    points:
      "0,1450 451,1523 541,1622 676,1644 789,1573 881,1461 1100,1650 1350,1850 1900,1950 1900,2300 0,2300",
  },
];

// Point-of-interest markers: specific spots on the map that carry their own
// lore tag rather than a full district polygon.
type MarkerShape = {
  value: DistrictValue;
  color: string;
  pos: [number, number];
};

const MARKERS: MarkerShape[] = [
  { value: "beastside", color: "#f0f", pos: [778, 885] },
];

export default function CityMap() {
  const [, navigate] = useLocation();
  const { data: entries, isLoading } = useListLore();
  const [hovered, setHovered] = useState<DistrictValue | null>(null);

  const byDistrict = useMemo(() => {
    const map = new Map<string, LoreEntrySummary>();
    for (const e of entries ?? []) {
      if (e.district && !map.has(e.district)) map.set(e.district, e);
    }
    return map;
  }, [entries]);

  const hoveredEntry = hovered ? byDistrict.get(hovered) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="font-mono text-xs text-muted-foreground">
          Hover a district to highlight it. Click to open its lore entry.
        </p>
        <div className="font-mono text-xs border border-border bg-card/50 px-3 py-2 min-w-[220px]" data-testid="text-map-hover-info">
          {hovered ? (
            <>
              <span className="font-display tracking-widest text-nc-cyan">{districtLabel(hovered)}</span>
              <span className="text-muted-foreground ml-2">
                {hoveredEntry ? `→ ${hoveredEntry.name}` : isLoading ? "Loading lore..." : "No lore entry tagged yet"}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Hover a district...</span>
          )}
        </div>
      </div>

      <div className="relative border border-nc-cyan/20 bg-card/30 p-1">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-auto block"
          role="img"
          aria-label="Interactive map of Night City districts"
          data-testid="svg-night-city-map"
        >
          <image href={mapImage} x={0} y={0} width={VIEW_W} height={VIEW_H} />
          {DISTRICT_SHAPES.map((d) => {
            const entry = byDistrict.get(d.value);
            const isHovered = hovered === d.value;
            return (
              <g key={d.value}>
                <polygon
                  points={d.points}
                  fill={d.color}
                  fillOpacity={isHovered ? 0.28 : 0}
                  stroke={d.color}
                  strokeOpacity={isHovered ? 0.9 : 0}
                  strokeWidth={6}
                  className={entry ? "cursor-pointer" : "cursor-default"}
                  style={{ transition: "fill-opacity 150ms, stroke-opacity 150ms" }}
                  onMouseEnter={() => setHovered(d.value)}
                  onMouseLeave={() => setHovered((h) => (h === d.value ? null : h))}
                  onClick={() => {
                    if (entry) navigate(`/directory/lore/${entry.id}`);
                  }}
                  data-testid={`polygon-district-${d.value}`}
                />
                {isHovered && (
                  <MapTooltip color={d.color} labelPos={d.labelPos} title={districtLabel(d.value)?.toUpperCase() ?? ""} entry={entry} />
                )}
              </g>
            );
          })}
          {MARKERS.map((m) => {
            const entry = byDistrict.get(m.value);
            const isHovered = hovered === m.value;
            return (
              <g key={m.value}>
                <circle
                  cx={m.pos[0]}
                  cy={m.pos[1]}
                  r={isHovered ? 34 : 26}
                  fill={m.color}
                  fillOpacity={isHovered ? 0.6 : 0.35}
                  stroke={m.color}
                  strokeWidth={5}
                  className={entry ? "cursor-pointer" : "cursor-default"}
                  style={{ transition: "r 150ms, fill-opacity 150ms" }}
                  onMouseEnter={() => setHovered(m.value)}
                  onMouseLeave={() => setHovered((h) => (h === m.value ? null : h))}
                  onClick={() => {
                    if (entry) navigate(`/directory/lore/${entry.id}`);
                  }}
                  data-testid={`marker-district-${m.value}`}
                />
                {isHovered && (
                  <MapTooltip
                    color={m.color}
                    labelPos={[m.pos[0], m.pos[1] - 90]}
                    title={districtLabel(m.value)?.toUpperCase() ?? ""}
                    entry={entry}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {[...DISTRICT_SHAPES, ...MARKERS].map((d) => {
          const entry = byDistrict.get(d.value);
          const inner = (
            <div
              className={`border px-3 py-2 font-mono text-xs flex items-center gap-2 ${entry ? "cursor-pointer hover:bg-card" : "opacity-60"}`}
              style={{ borderColor: d.color }}
              onMouseEnter={() => setHovered(d.value)}
              onMouseLeave={() => setHovered((h) => (h === d.value ? null : h))}
              data-testid={`card-district-${d.value}`}
            >
              <span className="w-2 h-2 shrink-0" style={{ backgroundColor: d.color }} />
              <span className="truncate">
                {districtLabel(d.value)}
                <span className="text-muted-foreground"> — {entry ? entry.name : "no lore yet"}</span>
              </span>
            </div>
          );
          return entry ? (
            <Link key={d.value} href={`/directory/lore/${entry.id}`}>{inner}</Link>
          ) : (
            <div key={d.value}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}

function MapTooltip({
  color,
  labelPos,
  title,
  entry,
}: {
  color: string;
  labelPos: [number, number];
  title: string;
  entry?: LoreEntrySummary;
}) {
  return (
    <g pointerEvents="none">
      <rect
        x={labelPos[0] - 190}
        y={labelPos[1] - 44}
        width={380}
        height={entry ? 96 : 88}
        fill="#0a0a0a"
        fillOpacity={0.85}
        stroke={color}
        strokeWidth={2}
      />
      <text x={labelPos[0]} y={labelPos[1]} textAnchor="middle" fill={color} fontSize={40} fontFamily="monospace" fontWeight="bold">
        {title}
      </text>
      <text x={labelPos[0]} y={labelPos[1] + 38} textAnchor="middle" fill="#e5e5e5" fontSize={26} fontFamily="monospace">
        {entry ? `→ ${entry.name}` : "No lore entry yet"}
      </text>
    </g>
  );
}
