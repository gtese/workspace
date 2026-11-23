from openpyxl import load_workbook

SRC = "source.xlsx"
OUT = "TraceIC-IT资产管理表_资产总表_精简版.xlsx"

OLD = "林益尧 - Leo - 13601657386"
NEW = "林益尧"

KEEP_COLS = 7  # IT编号, 资产编号, 设备类型, 品牌, 型号, 序列号, 使用人

wb = load_workbook(SRC, data_only=False)
ws = wb["资产总表"]
total_cols = ws.max_column
assert total_cols == 21, total_cols

# 1) 先删掉落在待删列上的数据有效性，避免悬空引用
for dv in list(ws.data_validations.dataValidation):
    keep = [r for r in dv.sqref.ranges if r.min_col <= KEEP_COLS]
    if keep:
        dv.sqref = keep
    else:
        ws.data_validations.dataValidation.remove(dv)

# 2) 删除第 8 列起的其余列
ws.delete_cols(KEEP_COLS + 1, total_cols - KEEP_COLS)

# 2b) 清掉已删除列残留的列宽定义
from openpyxl.utils import column_index_from_string
for key in list(ws.column_dimensions.keys()):
    if column_index_from_string(key) > KEEP_COLS:
        del ws.column_dimensions[key]

# 3) 在保留列内替换人员字符串（按整串相等替换，避免误伤）
replaced = 0
for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=1, max_col=KEEP_COLS):
    for cell in row:
        if isinstance(cell.value, str) and OLD in cell.value:
            cell.value = cell.value.replace(OLD, NEW)
            replaced += 1
print("replaced cells:", replaced)

wb.save(OUT)
print("saved:", OUT)
