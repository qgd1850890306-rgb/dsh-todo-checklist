"""独立复核 dsh-todo 导出的 .xlsx（不依赖插件自身代码，用 openpyxl 读）。

用法：python tests/_check-xlsx.py <file.xlsx>
"""
import json
import sys
import zipfile

import openpyxl

path = sys.argv[1]
report = {}

# 1) ZIP 完整性
with zipfile.ZipFile(path) as zf:
    report["zip_bad_entry"] = zf.testzip()
    report["zip_namelist"] = sorted(zf.namelist())
    sheet_xml = zf.read("xl/worksheets/sheet1.xml").decode("utf-8")

# 2) openpyxl 打开（Excel 兼容性的强证据）
wb = openpyxl.load_workbook(path)
ws = wb.active
report["sheet_title"] = ws.title
report["dimensions"] = ws.dimensions
report["max_row"] = ws.max_row
report["max_col"] = ws.max_column
report["freeze_panes"] = ws.freeze_panes

rows = [list(r) for r in ws.iter_rows(values_only=True)]
report["header"] = rows[0]
report["row_count"] = len(rows) - 1
report["first_data_row"] = rows[1]
report["last_data_row"] = rows[-1]

# 3) 控制字符（XML 1.0 非法区）
bad = []
for r_i, row in enumerate(rows, 1):
    for c_i, cell in enumerate(row, 1):
        if isinstance(cell, str):
            found = [ord(ch) for ch in cell if ord(ch) < 32 and ch not in "\n\r\t"]
            if found:
                bad.append((r_i, c_i, found))
report["illegal_control_chars"] = bad

# 4) 序号列必须是数字类型（不是字符串）
report["seq_types"] = [type(cell).__name__ for cell in [r[0] for r in rows[1:]]]

# 5) XML 里不能出现裸的 & < >（未转义）
report["sheet_xml_has_inlineStr"] = sheet_xml.count("<is>")
report["sheet_xml_row_tags"] = sheet_xml.count("<row ")

print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
