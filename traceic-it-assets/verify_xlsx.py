from openpyxl import load_workbook

src = load_workbook("source.xlsx", data_only=False)["资产总表"]
out = load_workbook("TraceIC-IT资产管理表_资产总表_精简版.xlsx", data_only=False)["资产总表"]

assert out.max_column == 7, out.max_column
assert out.max_row == src.max_row, (out.max_row, src.max_row)
headers = [out.cell(row=1, column=c).value for c in range(1, 8)]
print("headers:", headers)
assert headers == ["IT编号", "资产编号", "设备类型", "品牌", "型号", "序列号", "使用人"], headers

diff = 0
for r in range(2, src.max_row + 1):
    for c in range(1, 8):
        s, o = src.cell(row=r, column=c).value, out.cell(row=r, column=c).value
        if s != o:
            if s == "林益尧 - Leo - 13601657386" and o == "林益尧":
                continue
            print("UNEXPECTED DIFF", r, c, repr(s), "->", repr(o))
            diff += 1
print("unexpected diffs:", diff)

# 无残留
left = [c.value for row in out.iter_rows() for c in row
        if isinstance(c.value, str) and ("13601657386" in c.value or "林益尧 - Leo" in c.value)]
print("residual old strings:", left)

people = sorted({out.cell(row=r, column=7).value for r in range(2, out.max_row + 1) if out.cell(row=r, column=7).value})
print("使用人 distinct:", people)

# 样式与宽度抽查
print("col widths:", {k: v.width for k, v in out.column_dimensions.items()})
print("A1 font:", out["A1"].font.name, out["A1"].font.sz, "| G2 font:", out["G2"].font.name, out["G2"].font.sz)
print("data validations:", [(dv.sqref, dv.type) for dv in out.data_validations.dataValidation])
print("merged:", out.merged_cells.ranges, "| tables:", out.tables)
print("first rows:")
for r in range(1, 6):
    print(" ", r, [out.cell(row=r, column=c).value for c in range(1, 8)])
print("last rows:")
for r in range(out.max_row - 2, out.max_row + 1):
    print(" ", r, [out.cell(row=r, column=c).value for c in range(1, 8)])
